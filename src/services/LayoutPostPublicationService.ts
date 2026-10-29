import type { LayoutRecord } from "@prisma/client";
import { dozzleLog } from "../helper/dozzleLogger";
import {
  buildLayoutPostPayload,
  buildLayoutPostRedirectPayload,
  LayoutPostImageSource,
  resolveLayoutPostImageSource,
} from "./LayoutPostService";
import {
  ConcurrentLayoutRelocationError,
  LayoutDiscordPostAlreadyBoundError,
  LayoutRecordNotFoundError,
  LayoutService,
  layoutService,
} from "./LayoutService";

export const MAX_LAYOUT_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const LAYOUT_ATTACHMENT_FETCH_TIMEOUT_MS = 15_000;

type PublishedLayoutMessage = {
  id: string;
  delete: () => Promise<unknown>;
  edit?: (payload: LayoutPostDiscordPayload) => Promise<unknown>;
};

export type LayoutPostDiscordPayload = ReturnType<typeof buildLayoutPostPayload> & {
  files?: Array<{ attachment: Buffer; name: string }>;
  attachments?: [];
};

export type ResolvedLayoutPostMessage = PublishedLayoutMessage & {
  edit: (payload: LayoutPostDiscordPayload) => Promise<unknown>;
  author?: { id?: string | null } | null;
  editable?: boolean;
  attachments?: {
    first?: () => {
      name?: string | null;
      url?: string | null;
      contentType?: string | null;
      size?: number | null;
    } | undefined;
  };
  embeds?: Array<{
    image?: { url?: string | null } | null;
  } | null>;
};

export type LayoutPostChannel = {
  id: string;
  send: (payload: LayoutPostDiscordPayload) => Promise<PublishedLayoutMessage>;
};

export type LayoutPostAttachmentSource = {
  url: string;
  filename?: string | null;
  contentType?: string | null;
  size?: number | null;
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
    Partial<Pick<LayoutService, "updatePresentation" | "rebindDiscordPost">>;
  messageResolver?: LayoutPostMessageResolver;
  fetch?: LayoutFetch;
};

/** Purpose: publish one canonical layout post and resolve concurrent publication races without duplicate public posts. */
export class LayoutPostPublicationService {
  private readonly layoutService: Pick<LayoutService, "attachDiscordPost" | "findById"> &
    Partial<Pick<LayoutService, "updatePresentation" | "rebindDiscordPost">>;
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
    const layout = preparedAttachment ? { ...input.layout, imageUrl: null } : input.layout;
    const existing = getCompleteProvenance(input.layout);

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
          Boolean(input.layout.imageUrl),
        ),
      );
      const persistedLayout = await this.persistNativeOwnershipAfterEdit(
        input.layout,
        preparedAttachment,
        existingMessage,
      );
      return {
        layout: persistedLayout,
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
    let attached: LayoutRecord;
    try {
      attached = await this.layoutService.attachDiscordPost({
        id: input.layout.id,
        guildId: input.guildId,
        channelId: input.channel.id,
        messageId: message.id,
        imageUrl: input.layout.imageUrl,
      });
    } catch (error) {
      if (error instanceof LayoutDiscordPostAlreadyBoundError) {
        await deleteBestEffort(message);
        if (preparedAttachment) {
          throw new Error("Another canonical layout post won this native image update. Please retry the update.");
        }
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
    const persistedLayout = await this.persistNativeOwnershipAfterBind(input.layout, preparedAttachment, message);
    return {
      layout: persistedLayout ?? attached,
      messageId: message.id,
      jumpUrl: buildDiscordJumpUrl(input.guildId, input.channel.id, message.id),
    };
  }

  /**
   * Purpose: publish a new canonical post, CAS-rebind its provenance, and leave the old post as a redirect.
   * The old post remains authoritative until the durable rebind succeeds.
   */
  async relocate(input: {
    layout: LayoutRecord;
    guildId: string;
    channel: LayoutPostChannel;
    messageResolver: LayoutPostMessageResolver;
    botUserId: string;
  }): Promise<LayoutRelocationResult> {
    const existing = getCompleteProvenance(input.layout);
    if (!existing) throw new Error("The canonical layout post has incomplete provenance.");
    if (existing.guildId !== input.guildId) {
      throw new Error("The canonical layout post belongs to another guild.");
    }

    const current = await this.layoutService.findById(input.layout.id);
    if (current === null) throw new LayoutRecordNotFoundError(input.layout.id);
    const currentProvenance = current ? getCompleteProvenance(current) : null;
    if (current && currentProvenance) {
      if (currentProvenance.guildId === input.guildId && currentProvenance.channelId === input.channel.id) {
        return {
          layout: current,
          messageId: currentProvenance.messageId,
          jumpUrl: buildDiscordJumpUrl(
            currentProvenance.guildId,
            currentProvenance.channelId,
            currentProvenance.messageId,
          ),
          oldPostCleanupFailed: false,
        };
      }
      if (!sameLayoutVersion(current, input.layout) || !sameProvenance(currentProvenance, existing)) {
        throw new ConcurrentLayoutRelocationError(input.layout.id);
      }
    }

    const sourceMessage = await input.messageResolver.resolve(existing);
    if (!sourceMessage || sourceMessage.id !== existing.messageId) {
      throw new Error("The canonical Discord layout post could not be resolved.");
    }
    if (sourceMessage.author?.id !== input.botUserId) {
      throw new Error("The canonical Discord layout post is not authored by this bot.");
    }

    const attachment = input.layout.imageUrl === null
      ? getMessageAttachmentSource(sourceMessage)
      : null;
    const preparedAttachment = attachment
      ? await this.prepareAttachment(attachment)
      : null;
    const message = await input.channel.send(
      buildSendPayload(
        buildLayoutPostPayload(
          input.layout,
          "collapsed",
          preparedAttachment ? { attachmentName: preparedAttachment.filename } : {},
        ),
        preparedAttachment,
      ),
    );

    let rebound: LayoutRecord;
    try {
      if (!this.layoutService.rebindDiscordPost) {
        throw new Error("The layout provenance relocation operation is unavailable.");
      }
      rebound = await this.layoutService.rebindDiscordPost({
        id: input.layout.id,
        expectedOldGuildId: existing.guildId,
        expectedOldChannelId: existing.channelId,
        expectedOldMessageId: existing.messageId,
        expectedLayoutLink: input.layout.layoutLink,
        expectedSubmittedAt: input.layout.submittedAt,
        expectedTitle: input.layout.title,
        expectedDescription: input.layout.description,
        expectedImageUrl: input.layout.imageUrl,
        expectedPostedByDiscordUserId: input.layout.postedByDiscordUserId,
        expectedLastConfirmedAt: input.layout.lastConfirmedAt,
        expectedLastConfirmedByDiscordUserId: input.layout.lastConfirmedByDiscordUserId,
        newGuildId: input.guildId,
        newChannelId: input.channel.id,
        newMessageId: message.id,
      });
    } catch (error) {
      logRelocationEvent(
        error instanceof ConcurrentLayoutRelocationError ? "cas_conflict" : "rebind_failed",
        {
          layoutId: input.layout.id,
          oldMessageId: existing.messageId,
          newMessageId: message.id,
          guildId: input.guildId,
          phase: "provenance_rebind",
        },
      );
      const verification = await verifyRelocationAfterRebindFailure(
        this.layoutService,
        input.layout,
        existing,
        input.guildId,
        input.channel.id,
        message.id,
      );
      if (verification.kind === "new_canonical") {
        rebound = verification.layout;
        logRelocationEvent("rebind_recovered", {
          layoutId: input.layout.id,
          oldMessageId: existing.messageId,
          newMessageId: message.id,
          guildId: input.guildId,
          phase: "provenance_rebind",
        });
      } else if (verification.kind === "old_canonical") {
        const cleanup = await deleteNewMessageIfSafe(
          this.layoutService,
          message,
          input.layout,
          existing,
          input.guildId,
          input.channel.id,
          message.id,
        );
        if (cleanup !== "deleted") {
          logRelocationEvent("uncertain_outcome", {
            layoutId: input.layout.id,
            oldMessageId: existing.messageId,
            newMessageId: message.id,
            guildId: input.guildId,
            phase: "rebind_failure_cleanup",
          });
          throw new UncertainLayoutRelocationError(input.layout.id, existing.messageId, message.id);
        }
        throw error;
      } else {
        logRelocationEvent("uncertain_outcome", {
          layoutId: input.layout.id,
          oldMessageId: existing.messageId,
          newMessageId: message.id,
          guildId: input.guildId,
          phase: "provenance_rebind",
        });
        throw new UncertainLayoutRelocationError(input.layout.id, existing.messageId, message.id);
      }
    }

    const jumpUrl = buildDiscordJumpUrl(input.guildId, input.channel.id, message.id);
    let oldPostCleanupFailed = false;
    try {
      await sourceMessage.edit(buildLayoutPostRedirectPayload(jumpUrl));
    } catch {
      oldPostCleanupFailed = true;
      logRelocationEvent("old_redirect_failed", {
        layoutId: input.layout.id,
        oldMessageId: existing.messageId,
        newMessageId: message.id,
        guildId: input.guildId,
      });
    }
    return {
      layout: rebound,
      messageId: message.id,
      jumpUrl,
      oldPostCleanupFailed,
    };
  }

  /** Purpose: collapse the canonical post using its old record before a link-only CAS replacement commits. */
  async collapseBeforeLinkReplacement(input: {
    layout: LayoutRecord;
    message: ResolvedLayoutPostMessage;
  }): Promise<void> {
    await input.message.edit(
      buildLayoutPostPayload(
        input.layout,
        "collapsed",
        getMessageImageSource(input.message),
      ),
    );
  }

  /** Purpose: persist native ownership only after an existing canonical message accepted the replacement. */
  private async persistNativeOwnershipAfterEdit(
    originalLayout: LayoutRecord,
    attachment: PreparedLayoutPostAttachment | null,
    message: ResolvedLayoutPostMessage,
  ): Promise<LayoutRecord> {
    if (!attachment || originalLayout.imageUrl === null) return originalLayout;
    try {
      return await this.persistNativeOwnership(originalLayout);
    } catch {
      await restorePreviousPresentation(message, originalLayout);
      throw nativeOwnershipPersistenceError();
    }
  }

  /** Purpose: persist native ownership only after a new canonical message has been bound to this record. */
  private async persistNativeOwnershipAfterBind(
    originalLayout: LayoutRecord,
    attachment: PreparedLayoutPostAttachment | null,
    message: PublishedLayoutMessage,
  ): Promise<LayoutRecord | null> {
    if (!attachment || originalLayout.imageUrl === null) return null;
    try {
      return await this.persistNativeOwnership(originalLayout);
    } catch {
      await restorePreviousPresentation(message, originalLayout);
      throw nativeOwnershipPersistenceError();
    }
  }

  /** Purpose: keep the durable external image owner until the Discord publication is safely canonical. */
  private async persistNativeOwnership(layout: LayoutRecord): Promise<LayoutRecord> {
    if (!this.layoutService.updatePresentation) {
      throw new Error("The layout image ownership could not be saved.");
    }
    return this.layoutService.updatePresentation(layout.id, { imageUrl: null });
  }

  /** Purpose: download and sanitize one Discord interaction attachment before it becomes canonical bot-owned content. */
  private async prepareAttachment(source: LayoutPostAttachmentSource): Promise<PreparedLayoutPostAttachment> {
    const url = String(source.url ?? "").trim();
    if (!/^https?:\/\//i.test(url)) throw new Error("The layout image attachment URL is invalid.");
    if (!isLayoutAttachmentSizeSupported(source.size)) {
      throw new Error("The layout image attachment is too large.");
    }
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

/** Purpose: share the Discord byte limit between command-side metadata validation and downloaded-content validation. */
export function isLayoutAttachmentSizeSupported(size: number | null | undefined): boolean {
  return size === null || size === undefined ||
    (Number.isSafeInteger(size) && size >= 0 && size <= MAX_LAYOUT_ATTACHMENT_BYTES);
}

/** Purpose: keep Discord fetch/edit mechanics inside the focused layout publication integration. */
export function createDiscordLayoutPostResolver(
  client: {
  channels: { fetch: (channelId: string) => Promise<unknown> };
    user?: { id?: string | null } | null;
  },
  options: { requireBotAuthored?: boolean; requireEditable?: boolean } = {},
): LayoutPostMessageResolver {
  return {
    resolve: async ({ channelId, messageId }) => {
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (!channel || typeof channel !== "object" || !("messages" in channel)) return null;
      const messages = (channel as { messages?: unknown }).messages;
      if (!messages || typeof messages !== "object" || !("fetch" in messages) ||
        typeof (messages as { fetch?: unknown }).fetch !== "function") return null;
      const message = await (messages as { fetch: (id: string) => Promise<unknown> }).fetch(messageId).catch(() => null);
      if (!message || typeof message !== "object" || typeof (message as { edit?: unknown }).edit !== "function") return null;
      const resolved = message as ResolvedLayoutPostMessage;
      if (options.requireEditable !== false && resolved.editable === false) return null;
      if (options.requireBotAuthored) {
        const botUserId = client.user?.id;
        if (!botUserId || resolved.author?.id !== botUserId) return null;
      }
      return resolved;
    },
  };
}

function getCompleteProvenance(layout: LayoutRecord): { guildId: string; channelId: string; messageId: string } | null {
  if (!layout.discordGuildId || !layout.discordChannelId || !layout.discordMessageId) return null;
  return { guildId: layout.discordGuildId, channelId: layout.discordChannelId, messageId: layout.discordMessageId };
}

type RelocationVerification =
  | { kind: "new_canonical"; layout: LayoutRecord }
  | { kind: "old_canonical" }
  | { kind: "uncertain" };

async function verifyRelocationAfterRebindFailure(
  service: Pick<LayoutService, "findById">,
  expectedLayout: LayoutRecord,
  expectedOld: { guildId: string; channelId: string; messageId: string },
  newGuildId: string,
  newChannelId: string,
  newMessageId: string,
): Promise<RelocationVerification> {
  let current: LayoutRecord | null;
  try {
    current = await service.findById(expectedLayout.id);
  } catch {
    logRelocationEvent("rebind_verification_failed", {
      layoutId: expectedLayout.id,
      oldMessageId: expectedOld.messageId,
      newMessageId,
      guildId: newGuildId,
      phase: "rebind_verification",
    });
    return { kind: "uncertain" };
  }

  const currentProvenance = current ? getCompleteProvenance(current) : null;
  if (
    current &&
    currentProvenance &&
    currentProvenance.guildId === newGuildId &&
    currentProvenance.channelId === newChannelId &&
    currentProvenance.messageId === newMessageId
  ) {
    return { kind: "new_canonical", layout: current };
  }
  if (current && currentProvenance && sameProvenance(currentProvenance, expectedOld) && sameLayoutVersion(current, expectedLayout)) {
    return { kind: "old_canonical" };
  }

  logRelocationEvent("rebind_verification_failed", {
    layoutId: expectedLayout.id,
    oldMessageId: expectedOld.messageId,
    newMessageId,
    guildId: newGuildId,
    phase: current ? "rebind_verification_conflict" : "rebind_verification_missing",
  });
  return { kind: "uncertain" };
}

async function deleteNewMessageIfSafe(
  service: Pick<LayoutService, "findById">,
  message: PublishedLayoutMessage,
  expectedLayout: LayoutRecord,
  expectedOld: { guildId: string; channelId: string; messageId: string },
  guildId: string,
  channelId: string,
  newMessageId: string,
): Promise<"deleted" | "canonical" | "uncertain"> {
  let current: LayoutRecord | null;
  try {
    current = await service.findById(expectedLayout.id);
  } catch {
    logRelocationEvent("rebind_verification_failed", {
      layoutId: expectedLayout.id,
      oldMessageId: expectedOld.messageId,
      newMessageId,
      guildId,
      phase: "pre_cleanup_verification",
    });
    return "uncertain";
  }
  const currentProvenance = current ? getCompleteProvenance(current) : null;
  if (
    currentProvenance?.guildId === guildId &&
    currentProvenance.channelId === channelId &&
    currentProvenance.messageId === newMessageId
  ) {
    logRelocationEvent("canonical_message_preserved", {
      layoutId: expectedLayout.id,
      oldMessageId: expectedOld.messageId,
      newMessageId,
      guildId,
      phase: "pre_cleanup_verification",
    });
    return "canonical";
  }
  if (!current || !currentProvenance || !sameProvenance(currentProvenance, expectedOld) || !sameLayoutVersion(current, expectedLayout)) {
    logRelocationEvent("rebind_verification_failed", {
      layoutId: expectedLayout.id,
      oldMessageId: expectedOld.messageId,
      newMessageId,
      guildId,
      phase: "pre_cleanup_verification",
    });
    return "uncertain";
  }
  try {
    await message.delete();
    return "deleted";
  } catch {
    logRelocationEvent("new_message_cleanup_failed", {
      layoutId: expectedLayout.id,
      oldMessageId: expectedOld.messageId,
      newMessageId,
      guildId,
      phase: "rebind_failure_cleanup",
    });
    return "uncertain";
  }
}

function sameProvenance(
  left: { guildId: string; channelId: string; messageId: string },
  right: { guildId: string; channelId: string; messageId: string },
): boolean {
  return left.guildId === right.guildId && left.channelId === right.channelId && left.messageId === right.messageId;
}

function sameLayoutVersion(left: LayoutRecord, right: LayoutRecord): boolean {
  return left.id === right.id &&
    left.layoutLink === right.layoutLink &&
    left.submittedAt?.getTime() === right.submittedAt?.getTime() &&
    left.title === right.title &&
    left.description === right.description &&
    left.imageUrl === right.imageUrl &&
    left.postedByDiscordUserId === right.postedByDiscordUserId &&
    left.lastConfirmedAt?.getTime() === right.lastConfirmedAt?.getTime() &&
    left.lastConfirmedByDiscordUserId === right.lastConfirmedByDiscordUserId;
}

export type LayoutRelocationResult = {
  layout: LayoutRecord;
  messageId: string;
  jumpUrl: string;
  oldPostCleanupFailed: boolean;
};

/** Purpose: preserve a newly published message when canonical state cannot be verified after an ambiguous failure. */
export class UncertainLayoutRelocationError extends Error {
  readonly layoutId: string;
  readonly oldMessageId: string;
  readonly newMessageId: string;

  constructor(layoutId: string, oldMessageId: string, newMessageId: string) {
    super(`Layout post relocation requires reconciliation before retrying: ${layoutId}`);
    this.name = "UncertainLayoutRelocationError";
    this.layoutId = layoutId;
    this.oldMessageId = oldMessageId;
    this.newMessageId = newMessageId;
  }
}

async function deleteBestEffort(
  message: PublishedLayoutMessage,
  context?: {
    layoutId: string;
    phase: string;
    newMessageId: string;
    oldMessageId?: string;
    guildId?: string;
  },
): Promise<void> {
  try {
    await message.delete();
  } catch {
    if (context) {
      logRelocationEvent("new_message_cleanup_failed", context);
    }
  }
}

function getMessageAttachmentSource(
  message: ResolvedLayoutPostMessage,
): LayoutPostAttachmentSource | null {
  const resolution = resolveLayoutPostImageSource(message);
  const attachment = message.attachments?.first?.();
  const url = resolution.source.attachmentUrl;
  if (!url) {
    if (
      resolution.kind === "attachment_collection" ||
      resolution.kind === "embedded_attachment" ||
      resolution.kind === "metadata_unavailable"
    ) {
      dozzleLog.warn(
        `[layout-relocation] event=image_source_unresolved reason=attachment_url_unavailable message_id=${message.id}`,
      );
      throw new Error("The canonical layout image could not be safely copied.");
    }
    return null;
  }
  if (attachment?.contentType && !attachment.contentType.toLowerCase().startsWith("image/")) {
    throw new Error("The canonical layout attachment is not an image.");
  }
  return {
    url,
    filename: attachment?.name ?? resolution.source.attachmentName,
    contentType: attachment?.contentType,
    size: attachment?.size,
  };
}

function logRelocationEvent(
  event:
    | "old_redirect_failed"
    | "new_message_cleanup_failed"
    | "cas_conflict"
    | "rebind_failed"
    | "rebind_recovered"
    | "rebind_verification_failed"
    | "uncertain_outcome"
    | "canonical_message_preserved",
  input: { layoutId: string; oldMessageId?: string; newMessageId: string; guildId?: string; phase?: string },
): void {
  dozzleLog.warn(
    `[layout-relocation] event=${event} layout_id=${input.layoutId} guild_id=${input.guildId ?? "unknown"} old_message_id=${input.oldMessageId ?? "unknown"} new_message_id=${input.newMessageId} phase=${input.phase ?? "old_redirect"}`,
  );
}

async function restorePreviousPresentation(message: PublishedLayoutMessage, layout: LayoutRecord): Promise<void> {
  if (!message.edit) return;
  try {
    await message.edit(buildEditPayload(buildLayoutPostPayload(layout, "collapsed"), null, true));
  } catch { /* Compensation is best effort; the durable external owner remains recorded. */ }
}

function nativeOwnershipPersistenceError(): Error {
  return new Error(
    "The native layout image was published, but durable image ownership could not be saved. The previous image remains recorded; please retry.",
  );
}

function getMessageImageSource(message: ResolvedLayoutPostMessage): LayoutPostImageSource {
  const resolution = resolveLayoutPostImageSource(message);
  if (resolution.kind === "embedded_attachment" || resolution.kind === "embedded_url") {
    dozzleLog.debug(
      `[layout-publication] event=image_source_fallback source=${resolution.kind} message_id=${message.id}`,
    );
  } else if (resolution.kind === "metadata_unavailable") {
    dozzleLog.warn(
      `[layout-publication] event=image_source_unresolved reason=metadata_unavailable message_id=${message.id}`,
    );
  }
  return resolution.source;
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
