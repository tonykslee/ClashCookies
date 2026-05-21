import { SettingsService } from "./SettingsService";

const BOT_LOG_CHANNEL_SETTING_PREFIX = "bot_logs_channel";
export const BOT_LOG_CHANNEL_TYPES = ["base-swap", "maintenance"] as const;
export type BotLogChannelType = (typeof BOT_LOG_CHANNEL_TYPES)[number];

/** Purpose: build per-guild setting key for bot-log channel configuration. */
function botLogChannelKey(
  guildId: string,
  type?: BotLogChannelType,
): string {
  return type
    ? `${BOT_LOG_CHANNEL_SETTING_PREFIX}:${guildId}:${type}`
    : `${BOT_LOG_CHANNEL_SETTING_PREFIX}:${guildId}`;
}

export class BotLogChannelService {
  /** Purpose: initialize service dependencies. */
  constructor(private readonly settings = new SettingsService()) {}

  /** Purpose: get configured bot-log channel id for a guild. */
  async getChannelId(guildId: string): Promise<string | null> {
    const raw = await this.settings.get(botLogChannelKey(guildId));
    if (!raw) return null;
    const normalized = raw.trim();
    if (!/^\d+$/.test(normalized)) return null;
    return normalized;
  }

  /** Purpose: get configured typed bot-log channel id for a guild. */
  async getChannelIdForType(
    guildId: string,
    type: BotLogChannelType,
  ): Promise<string | null> {
    const raw = await this.settings.get(botLogChannelKey(guildId, type));
    if (!raw) return null;
    const normalized = raw.trim();
    if (!/^\d+$/.test(normalized)) return null;
    return normalized;
  }

  /** Purpose: persist configured bot-log channel id for a guild. */
  async setChannelId(guildId: string, channelId: string): Promise<void> {
    await this.settings.set(botLogChannelKey(guildId), channelId);
  }

  /** Purpose: persist configured typed bot-log channel id for a guild. */
  async setChannelIdForType(
    guildId: string,
    type: BotLogChannelType,
    channelId: string,
  ): Promise<void> {
    await this.settings.set(botLogChannelKey(guildId, type), channelId);
  }

  /** Purpose: clear configured bot-log channel id for a guild. */
  async clearChannelId(guildId: string): Promise<void> {
    await this.settings.delete(botLogChannelKey(guildId));
  }

  /** Purpose: clear configured typed bot-log channel id for a guild. */
  async clearChannelIdForType(
    guildId: string,
    type: BotLogChannelType,
  ): Promise<void> {
    await this.settings.delete(botLogChannelKey(guildId, type));
  }
}

/** Purpose: share a single bot-log routing service instance across callers. */
export const botLogChannelService = new BotLogChannelService();
