import type { LayoutRecord } from "@prisma/client";
import { buildLayoutPostPayload, LayoutPostImageSource } from "./LayoutPostService";
import { LayoutDiscordPostAlreadyBoundError, LayoutService, layoutService } from "./LayoutService";

const MAX_LAYOUT_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const LAYOUT_ATTACHMENT_FETCH_TIMEOUT_MS = 15_000;

type PublishedLayoutMessage = { id: string; delete: () => Promise<unknown> };

export type LayoutPostDiscordPayload = ReturnType<typeof buildLayoutPostPayload> & {
  files?: Array<{ attachment: Buffer; name: string }>;
  attachments?: [];
};

export type ResolvedLayoutPostMessage = PublishedLayoutMessage & {
  edit: (payload: LayoutPostDiscordPayload) => Promise<unknown>;
  attachments?: { first?: () => { name?: string | null; url?: string | null } | undefined };
};

export type LayoutPostChannel = {
  id: string;
  send: (payload: LayoutPostDiscordPayload) => Promise<PublishedLayoutMessage>;
};

export type LayoutPostAttachmentSource = {
  url: string;
  filename?: string | null;
  contentType?: string | null;
};

type PreparedLayoutPostAttachment = { data: Buffer; filename: string };

type LayoutFetch = (
  input: string,
  init?: { signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  headers: { get: (name: string) => string | null };
  arrayBuffer: () => Promise<ArrayBuffer>;
}>;

export type LayoutPostMessageResolver = {
  resolve: (input: { guildId: string; channelId: string; messageId: string }) =>
    Promise<ResolvedLayoutPostMessage | null>;
};

export type LayoutPostPublicationResult = { layout: LayoutRecord; messageId: string; jumpUrl: string };

export type LayoutPostPublicationServiceOptions = {
  layoutService?: Pick<LayoutService, "attachDiscordPost" | "findById"> &
    Partial<Pick<LayoutService, "updatePresentation">>;
  messageResolver?: LayoutPostMessageResolver;
  fetch?: LayoutFetch;
};

/** Purpose: publish one canonical layout post and resolve concurrent publication races without duplicate public posts. */
export class LayoutPostPublicationService {
  private readonly layoutService: Pick<LayoutService, "attachDiscordPost" | "findById"> &
    Partial<Pick<LayoutService, "updatePresentation">>;
  private readonly messageResolver?: LayoutPostMessageResolver;
  private readonly fetch: LayoutFetch;

  constructor(options: LayoutPostPublicationServiceOptions = {}) {
    this.layoutService = options.layoutService ?? layoutService;
    this.messageResolver = options.messageResolver;
    const runtimeFetch = (globalThis as typeof globalThis & { fetch?: LayoutFetch }).fetch;
    if (!options.fetch && !runtimeFetch) {
      throw new Error("The runtime does not provide HTTP fetch support for layout images.");
    }
    this.fetch = options.fetch ?? runtimeFetch!;
  }

  /** Purpose: publish or refresh one canonical public layout post while keeping native images bot-owned. */
  async publish(input: {
    layout: LayoutRecord;
    guildId: string;
    channel: LayoutPostChannel;
    messageResolver?: LayoutPostMessageResolver;
    attachment?: LayoutPostAttachmentSource;
  }): Promise<LayoutPostPublicationResult> {
    const preparedAttachment = input.attachment
      ? await this.prepareAttachment(input.attachment)
      : null;
    const layout = preparedAttachment
      ? await this.clearPersistedImage(input.layout)
      : input.layout;
    const existing = getCompleteProvenance(layout);

    if (existing) {
      const resolver = input.messageResolver ?? this.messageResolver;
      if (!resolver) {
        throw new Error("A canonical Discord post resolver is required to refresh the existing post.");
      }
      const existingMessage = await resolver.resolve(existing);
      if (!existingMessage) {
        throw new Error("The canonical Discord layout post could not be resolved; no replacement was created.");
      }
      await existingMessage.edit(
        buildEditPayload(
          buildLayoutPostPayload(
            layout,
            "collapsed",
            preparedAttachment
              ? { attachmentName: preparedAttachment.filename }
              : getMessageImageSource(existingMessage),
          ),
          preparedAttachment,
          Boolean(layout.imageUrl),
        ),
      );
      return {
        layout,
        messageId: existing.messageId,
        jumpUrl: buildDiscordJumpUrl(existing.guildId, existing.channelId, existing.messageId),
      };
    }

    const message = await input.channel.send(
      buildSendPayload(
        buildLayoutPostPayload(
          layout,
          "collapsed",
          preparedAttachment ? { attachmentName: preparedAttachment.filename } : {},
        ),
        preparedAttachment,
      ),
    );
    try {
      const attached = await this.layoutService.attachDiscordPost({
        id: layout.id,
        guildId: input.guildId,
        channelId: input.channel.id,
        messageId: message.id,
        imageUrl: layout.imageUrl,
      });
      return {
        layout: attached,
        messageId: message.id,
        jumpUrl: buildDiscordJumpUrl(input.guildId, input.channel.id, message.id),
      };
    } catch (error) {
      if (error instanceof LayoutDiscordPostAlreadyBoundError) {
        await deleteBestEffort(message);
        const winner = await this.layoutService.findById(layout.id);
        const winnerProvenance = winner ? getCompleteProvenance(winner) : null;
        if (winner && winnerProvenance) {
          return {
            layout: winner,
            messageId: winnerProvenance.messageId,
            jumpUrl: buildDiscordJumpUrl(
              winnerProvenance.guildId,
              winnerProvenance.channelId,
              winnerProvenance.messageId,
            ),
          };
        }
        throw error;
      }
      await deleteBestEffort(message);
      throw error;
    }
  }

  /** Purpose: clear only the durable external image owner after native bytes are fetched successfully. */
  private async clearPersistedImage(layout: LayoutRecord): Promise<LayoutRecord> {
    if (!this.layoutService.updatePresentation) {
      if (layout.imageUrl) throw new Error("The layout image could not be transferred safely.");
      return layout;
    }
    return this.layoutService.updatePresentation(layout.id, { imageUrl: null });
  }

  /** Purpose: download and sanitize one Discord interaction attachment before it becomes canonical bot-owned content. */
  private async prepareAttachment(source: LayoutPostAttachmentSource): Promise<PreparedLayoutPostAttachment> {
    const url = String(source.url ?? "").trim();
    if (!/^https?:\/\//i.test(url)) throw new Error("The layout image attachment URL is invalid.");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LAYOUT_ATTACHMENT_FETCH_TIMEOUT_MS);
    try {
      const response = await this.fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error("The layout image attachment could not be fetched.");
      const contentLength = Number(response.headers.get("content-length") ?? "");
      if (Number.isFinite(contentLength) && contentLength > MAX_LAYOUT_ATTACHMENT_BYTES) {
        throw new Error("The layout image attachment is too large.");
      }
      const data = Buffer.from(await response.arrayBuffer());
      if (data.byteLength > MAX_LAYOUT_ATTACHMENT_BYTES) throw new Error("The layout image attachment is too large.");
      return { data, filename: sanitizeAttachmentFilename(source.filename, source.contentType) };
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("The layout image attachment")) throw error;
      throw new Error("The layout image attachment could not be fetched.");
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** Purpose: keep Discord fetch/edit mechanics inside the focused layout publication integration. */
export function createDiscordLayoutPostResolver(client: {
  channels: { fetch: (channelId: string) => Promise<unknown> };
}): LayoutPostMessageResolver {
  return {
    resolve: async ({ channelId, messageId }) => {
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (!channel || typeof channel !== "object" || !("messages" in channel)) return null;
      const messages = (channel as { messages?: unknown }).messages;
      if (!messages || typeof messages !== "object" || !("fetch" in messages) ||
        typeof (messages as { fetch?: unknown }).fetch !== "function") return null;
      const message = await (messages as { fetch: (id: string) => Promise<unknown> }).fetch(messageId).catch(() => null);
      if (!message || typeof message !== "object" || typeof (message as { edit?: unknown }).edit !== "function") return null;
      return message as ResolvedLayoutPostMessage;
    },
  };
}

function getCompleteProvenance(layout: LayoutRecord): { guildId: string; channelId: string; messageId: string } | null {
  if (!layout.discordGuildId || !layout.discordChannelId || !layout.discordMessageId) return null;
  return { guildId: layout.discordGuildId, channelId: layout.discordChannelId, messageId: layout.discordMessageId };
}

async function deleteBestEffort(message: PublishedLayoutMessage): Promise<void> {
  try { await message.delete(); } catch { /* Cleanup is best effort after a binding race. */ }
}

function getMessageImageSource(message: ResolvedLayoutPostMessage): LayoutPostImageSource {
  const attachment = message.attachments?.first?.();
  return { attachmentName: attachment?.name ?? null, attachmentUrl: attachment?.url ?? null };
}

function buildSendPayload(payload: ReturnType<typeof buildLayoutPostPayload>, attachment: PreparedLayoutPostAttachment | null): LayoutPostDiscordPayload {
  return attachment ? { ...payload, files: [{ attachment: attachment.data, name: attachment.filename }] } : payload;
}

function buildEditPayload(
  payload: ReturnType<typeof buildLayoutPostPayload>,
  attachment: PreparedLayoutPostAttachment | null,
  removeExistingAttachments: boolean,
): LayoutPostDiscordPayload {
  return {
    ...payload,
    ...(attachment ? { files: [{ attachment: attachment.data, name: attachment.filename }] } : {}),
    ...(attachment || removeExistingAttachments ? { attachments: [] } : {}),
  };
}

function sanitizeAttachmentFilename(filename: string | null | undefined, contentType: string | null | undefined): string {
  const original = String(filename ?? "").split(/[\\/]/).pop() ?? "";
  const withoutControls = [...original]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? "_" : character;
    })
    .join("");
  const sanitized = withoutControls.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+$/, "").trim();
  const base = sanitized || "layout-image";
  if (/[.][A-Za-z0-9]{1,8}$/.test(base)) return base;
  return `${base}${imageExtensionForContentType(contentType)}`;
}

function imageExtensionForContentType(contentType: string | null | undefined): string {
  const normalized = String(contentType ?? "").toLowerCase().split(";", 1)[0];
  if (normalized === "image/jpeg") return ".jpg";
  if (normalized === "image/png") return ".png";
  if (normalized === "image/gif") return ".gif";
  if (normalized === "image/webp") return ".webp";
  if (normalized === "image/avif") return ".avif";
  return ".png";
}

/** Purpose: build a stable Discord jump link without exposing the Clash layout URL. */
export function buildDiscordJumpUrl(guildId: string, channelId: string, messageId: string): string {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

export const layoutPostPublicationService = new LayoutPostPublicationService();
