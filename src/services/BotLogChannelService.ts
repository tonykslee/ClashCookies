import { SettingsService } from "./SettingsService";

const BOT_LOG_CHANNEL_SETTING_PREFIX = "bot_logs_channel";

/** Purpose: build per-guild setting key for bot-log channel configuration. */
function botLogChannelKey(guildId: string): string {
  return `${BOT_LOG_CHANNEL_SETTING_PREFIX}:${guildId}`;
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

  /** Purpose: persist configured bot-log channel id for a guild. */
  async setChannelId(guildId: string, channelId: string): Promise<void> {
    await this.settings.set(botLogChannelKey(guildId), channelId);
  }

  /** Purpose: clear configured bot-log channel id for a guild. */
  async clearChannelId(guildId: string): Promise<void> {
    await this.settings.delete(botLogChannelKey(guildId));
  }
}
