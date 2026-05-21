import { Client } from "discord.js";
import { formatError } from "../helper/formatError";
import { BotLogChannelService, botLogChannelService } from "./BotLogChannelService";

export type MaintenanceFetchObservation =
  | { kind: "success" }
  | { kind: "failure"; statusCode: number | null };

export type MaintenanceWindowState = {
  active: boolean;
  lastDetectedAt: Date | null;
  lastOverAt: Date | null;
  lastChannelId: string | null;
  lastChannelSource: "maintenance" | "generic" | null;
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
  private readonly stateByGuildId = new Map<string, MaintenanceWindowState>();

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
  }): Promise<void> {
    const guildId = normalizeGuildId(input.guildId);
    const clanTag = normalizeClanTag(input.clanTag);
    if (!guildId) return;
    const statusCode =
      input.observation.kind === "failure" ? input.observation.statusCode : null;

    const current = this.stateByGuildId.get(guildId) ?? {
      active: false,
      lastDetectedAt: null,
      lastOverAt: null,
      lastChannelId: null,
      lastChannelSource: null,
    };

    const explicitMaintenanceDetected =
      input.observation.kind === "failure" &&
      isExplicitMaintenanceErrorForTest({
        error: input.error,
        statusCode: input.observation.statusCode,
      });

    if (explicitMaintenanceDetected) {
      if (current.active) return;

      const transitionAt = new Date();
      const channel = await this.resolveNoticeChannel(guildId);
      current.active = true;
      current.lastDetectedAt = transitionAt;
      current.lastChannelId = channel.channelId;
      current.lastChannelSource = channel.source;
      this.stateByGuildId.set(guildId, current);

      if (!channel.channelId) {
        console.warn(
          `[maintenance-window] event=skipped_no_channel phase=detected guild=${guildId} clan=${clanTag} status=${statusCode ?? "unknown"}`,
        );
        return;
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
      return;
    }

    if (input.observation.kind !== "success") return;
    if (!current.active) return;

    const transitionAt = new Date();
    const channel = await this.resolveNoticeChannel(guildId);
    current.active = false;
    current.lastOverAt = transitionAt;
    current.lastChannelId = channel.channelId;
    current.lastChannelSource = channel.source;
    this.stateByGuildId.set(guildId, current);

    if (!channel.channelId) {
      console.warn(
        `[maintenance-window] event=skipped_no_channel phase=over guild=${guildId} clan=${clanTag}`,
      );
      return;
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
