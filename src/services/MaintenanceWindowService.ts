import { Client } from "discord.js";
import { formatError } from "../helper/formatError";
import { prisma } from "../prisma";
import { BotLogChannelService, botLogChannelService } from "./BotLogChannelService";

export type MaintenanceFetchObservation =
  | { kind: "success" }
  | { kind: "failure"; statusCode: number | null };

export type MaintenanceTransition = "detected" | "over" | null;

export type MaintenanceObservationResult = {
  maintenanceTransition: MaintenanceTransition;
};

export type MaintenanceWindowState = {
  guildId: string;
  active: boolean;
  detectedAt: Date | null;
  lastObservedAt: Date | null;
  lastOverAt: Date | null;
  detectedClanTag: string | null;
  detectedStatusCode: number | null;
  lastChannelId: string | null;
  lastChannelSource: "maintenance" | "generic" | null;
  createdAt: Date;
  updatedAt: Date;
};

type MaintenanceChannelResolution = {
  channelId: string | null;
  source: "maintenance" | "generic" | null;
  channel:
    | {
        send: (input: { content: string }) => Promise<unknown>;
      }
    | null;
};

const MAINTENANCE_MARKER_REGEX =
  /\bmaintenance\b|scheduled maintenance|maintenance window|maintenance mode|under maintenance/i;

/** Purpose: recognize explicit CoC maintenance errors without confusing them with generic upstream failures. */
export function isExplicitMaintenanceErrorForTest(input: {
  error: unknown;
  statusCode?: number | null;
}): boolean {
  void input.statusCode;
  const text = formatError(input.error).toLowerCase();
  if (!text) return false;
  return MAINTENANCE_MARKER_REGEX.test(text);
}

function normalizeGuildId(input: string | null | undefined): string {
  return String(input ?? "").trim();
}

function normalizeClanTag(input: string | null | undefined): string {
  return String(input ?? "").trim().toUpperCase();
}

/** Purpose: observe war polling results and post one maintenance-start / maintenance-over notice per guild window. */
export class MaintenanceWindowService {
  /** Purpose: initialize maintenance observation service dependencies. */
  constructor(
    private readonly client: Client,
    private readonly botLogChannels: BotLogChannelService = botLogChannelService,
  ) {}

  /** Purpose: update maintenance state from one war fetch observation. */
  async observeWarFetch(input: {
    guildId: string;
    clanTag: string;
    observation: MaintenanceFetchObservation;
    error?: unknown;
  }): Promise<MaintenanceObservationResult> {
    try {
      const guildId = normalizeGuildId(input.guildId);
      const clanTag = normalizeClanTag(input.clanTag);
      if (!guildId) return { maintenanceTransition: null };
      const statusCode =
        input.observation.kind === "failure" ? input.observation.statusCode : null;

      const current = await this.getRuntimeState(guildId);
      const explicitMaintenanceDetected =
        input.observation.kind === "failure" &&
        isExplicitMaintenanceErrorForTest({
          error: input.error,
          statusCode: input.observation.statusCode,
        });

      if (explicitMaintenanceDetected) {
        if (current?.active) {
          await this.persistRuntimeState({
            guildId,
            active: true,
            lastObservedAt: new Date(),
            detectedClanTag: clanTag,
            detectedStatusCode: statusCode,
            lastChannelId: current.lastChannelId,
            lastChannelSource: current.lastChannelSource,
          });
          return { maintenanceTransition: null };
        }

        const transitionAt = new Date();
        const channel = await this.resolveNoticeChannel(guildId);
        await this.persistRuntimeState({
          guildId,
          active: true,
          detectedAt: transitionAt,
          lastObservedAt: transitionAt,
          detectedClanTag: clanTag,
          detectedStatusCode: statusCode,
          lastChannelId: channel.channelId,
          lastChannelSource: channel.source,
        });

        if (!channel.channelId) {
          console.warn(
            `[maintenance-window] event=skipped_no_channel phase=detected guild=${guildId} clan=${clanTag} status=${statusCode ?? "unknown"}`,
          );
          return { maintenanceTransition: "detected" };
        }

        await this.sendNotice(channel.channel, {
          content:
            "CoC maintenance detected while polling wars. War polling will resume automatically when the API recovers.",
        }).catch((err) => {
          console.error(
            `[maintenance-window] event=send_failed phase=detected guild=${guildId} clan=${clanTag} channel=${channel.channelId} source=${channel.source} error=${formatError(err)}`,
          );
        });

        console.log(
          `[maintenance-window] event=detected guild=${guildId} clan=${clanTag} channel=${channel.channelId} source=${channel.source} status=${statusCode ?? "unknown"}`,
        );
        return { maintenanceTransition: "detected" };
      }

      if (input.observation.kind !== "success") return { maintenanceTransition: null };
      if (!current?.active) return { maintenanceTransition: null };

      const transitionAt = new Date();
      const channel = await this.resolveNoticeChannel(guildId);
      await this.persistRuntimeState({
        guildId,
        active: false,
        lastObservedAt: transitionAt,
        lastOverAt: transitionAt,
        lastChannelId: channel.channelId,
        lastChannelSource: channel.source,
      });
      if (!channel.channelId) {
        console.warn(
          `[maintenance-window] event=skipped_no_channel phase=over guild=${guildId} clan=${clanTag}`,
        );
        return { maintenanceTransition: "over" };
      }

      await this.sendNotice(channel.channel, {
        content: "CoC maintenance is over. War polling has resumed.",
      }).catch((err) => {
        console.error(
          `[maintenance-window] event=send_failed phase=over guild=${guildId} clan=${clanTag} channel=${channel.channelId} source=${channel.source} error=${formatError(err)}`,
        );
      });

      console.log(
        `[maintenance-window] event=over guild=${guildId} clan=${clanTag} channel=${channel.channelId} source=${channel.source}`,
      );
      return { maintenanceTransition: "over" };
    } catch (err) {
      console.error(
        `[maintenance-window] event=handler_failed error=${formatError(err)}`,
      );
      return { maintenanceTransition: null };
    }
  }

  /** Purpose: read one guild's persisted maintenance runtime state. */
  async getRuntimeState(
    guildId: string,
  ): Promise<MaintenanceWindowState | null> {
    return (await prisma.maintenanceWindowRuntimeState.findUnique({
      where: { guildId },
    })) as MaintenanceWindowState | null;
  }

  /** Purpose: return whether one guild is currently marked inside a persisted maintenance window. */
  async isMaintenanceActive(guildId: string): Promise<boolean> {
    const state = await this.getRuntimeState(normalizeGuildId(guildId));
    return Boolean(state?.active);
  }

  /** Purpose: persist one guild's maintenance runtime state. */
  private async persistRuntimeState(input: {
    guildId: string;
    active: boolean;
    detectedAt?: Date | null;
    lastObservedAt?: Date | null;
    lastOverAt?: Date | null;
    detectedClanTag?: string | null;
    detectedStatusCode?: number | null;
    lastChannelId?: string | null;
    lastChannelSource?: "maintenance" | "generic" | null;
  }): Promise<void> {
    const existing = await this.getRuntimeState(input.guildId);
    await prisma.maintenanceWindowRuntimeState.upsert({
      where: { guildId: input.guildId },
      create: {
        guildId: input.guildId,
        active: input.active,
        detectedAt: input.detectedAt ?? null,
        lastObservedAt: input.lastObservedAt ?? null,
        lastOverAt: input.lastOverAt ?? null,
        detectedClanTag: input.detectedClanTag ?? null,
        detectedStatusCode:
          input.detectedStatusCode !== null &&
          input.detectedStatusCode !== undefined
            ? Math.trunc(input.detectedStatusCode)
            : null,
        lastChannelId: input.lastChannelId ?? null,
        lastChannelSource: input.lastChannelSource ?? null,
      },
      update: {
        active: input.active,
        detectedAt:
          input.detectedAt !== undefined
            ? input.detectedAt
            : existing?.detectedAt ?? null,
        lastObservedAt:
          input.lastObservedAt !== undefined
            ? input.lastObservedAt
            : existing?.lastObservedAt ?? null,
        lastOverAt:
          input.lastOverAt !== undefined
            ? input.lastOverAt
            : existing?.lastOverAt ?? null,
        detectedClanTag:
          input.detectedClanTag !== undefined
            ? input.detectedClanTag
            : existing?.detectedClanTag ?? null,
        detectedStatusCode:
          input.detectedStatusCode !== undefined
            ? input.detectedStatusCode === null
              ? null
              : Math.trunc(input.detectedStatusCode)
            : existing?.detectedStatusCode ?? null,
        lastChannelId:
          input.lastChannelId !== undefined
            ? input.lastChannelId
            : existing?.lastChannelId ?? null,
        lastChannelSource:
          input.lastChannelSource !== undefined
            ? input.lastChannelSource
            : existing?.lastChannelSource ?? null,
      },
    });
  }

  /** Purpose: resolve the best available bot-log channel for maintenance notices. */
  private async resolveNoticeChannel(guildId: string): Promise<MaintenanceChannelResolution> {
    const maintenanceChannelId = await this.botLogChannels.getChannelIdForType(
      guildId,
      "maintenance",
    );
    const maintenanceChannel = await this.fetchTextChannel(
      maintenanceChannelId,
    );
    if (maintenanceChannelId && maintenanceChannel) {
      return {
        channelId: maintenanceChannelId,
        source: "maintenance",
        channel: maintenanceChannel,
      };
    }

    const genericChannelId = await this.botLogChannels.getChannelId(guildId);
    const genericChannel = await this.fetchTextChannel(genericChannelId);
    if (genericChannelId && genericChannel) {
      return {
        channelId: genericChannelId,
        source: "generic",
        channel: genericChannel,
      };
    }

    return { channelId: null, source: null, channel: null };
  }

  /** Purpose: fetch one text-capable Discord channel if accessible. */
  private async fetchTextChannel(
    channelId: string | null,
  ): Promise<{ send: (input: { content: string }) => Promise<unknown> } | null> {
    const normalizedChannelId = String(channelId ?? "").trim();
    if (!normalizedChannelId) return null;
    try {
      const channel = await this.client.channels.fetch(normalizedChannelId);
      if (!channel) return null;
      const textBased =
        typeof (channel as { isTextBased?: () => boolean }).isTextBased ===
          "function" &&
        (channel as { isTextBased: () => boolean }).isTextBased();
      const canSend = typeof (channel as { send?: unknown }).send === "function";
      return textBased && canSend
        ? (channel as { send: (input: { content: string }) => Promise<unknown> })
        : null;
    } catch {
      return null;
    }
  }

  /** Purpose: send one maintenance notice payload to a resolved channel. */
  private async sendNotice(
    channel: { send: (input: { content: string }) => Promise<unknown> } | null,
    payload: { content: string },
  ): Promise<void> {
    if (!channel) {
      throw new Error("MAINTENANCE_CHANNEL_UNAVAILABLE");
    }
    await channel.send(payload);
  }
}
