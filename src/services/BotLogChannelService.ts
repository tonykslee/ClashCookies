import { SettingsService } from "./SettingsService";

const BOT_LOG_CHANNEL_SETTING_PREFIX = "bot_logs_channel";
const BASE_SWAP_ROUTING_SETTING_PREFIX = "bot_logs_base_swap_routing";
const ROUTED_BOT_LOG_ROUTING_SETTING_PREFIX = "bot_logs_routing";
export const BOT_LOG_CHANNEL_TYPES = [
  "base-swap",
  "maintenance",
  "sync",
  "checklist",
  "ban-log",
  "ban-join-alert",
] as const;
export type BotLogChannelType = (typeof BOT_LOG_CHANNEL_TYPES)[number];
export const SIMPLE_BOT_LOG_CHANNEL_TYPES = [
  "base-swap",
  "maintenance",
  "sync",
  "checklist",
] as const;
export type SimpleBotLogChannelType =
  (typeof SIMPLE_BOT_LOG_CHANNEL_TYPES)[number];
export const ROUTED_BOT_LOG_CHANNEL_TYPES = [
  "ban-log",
  "ban-join-alert",
] as const;
export type RoutedBotLogChannelType =
  (typeof ROUTED_BOT_LOG_CHANNEL_TYPES)[number];
export type BaseSwapBotLogRoutingMode =
  | "CLAN_LOG"
  | "CLAN_LEAD"
  | "BOT_LOG"
  | "CUSTOM"
  | "DISABLED";
export type BaseSwapBotLogRoutingConfig = {
  routingMode: BaseSwapBotLogRoutingMode;
  channelId: string | null;
  legacy: boolean;
};
export type RoutedBotLogRoutingConfig = {
  routingMode: BaseSwapBotLogRoutingMode;
  channelId: string | null;
  legacy: boolean;
  configured: boolean;
};

/** Purpose: build per-guild setting key for bot-log channel configuration. */
function botLogChannelKey(
  guildId: string,
  type?: BotLogChannelType,
): string {
  return type
    ? `${BOT_LOG_CHANNEL_SETTING_PREFIX}:${guildId}:${type}`
    : `${BOT_LOG_CHANNEL_SETTING_PREFIX}:${guildId}`;
}

function baseSwapRoutingKey(guildId: string): string {
  return `${BASE_SWAP_ROUTING_SETTING_PREFIX}:${guildId}`;
}

function routedBotLogRoutingKey(
  guildId: string,
  type: RoutedBotLogChannelType,
): string {
  return `${ROUTED_BOT_LOG_ROUTING_SETTING_PREFIX}:${guildId}:${type}`;
}

function normalizeChannelId(input: string | null | undefined): string | null {
  const value = String(input ?? "").trim();
  return /^\d+$/.test(value) ? value : null;
}

function normalizeBaseSwapRoutingMode(
  input: string | null | undefined,
): BaseSwapBotLogRoutingMode | null {
  const value = String(input ?? "").trim().toUpperCase();
  if (
    value === "CLAN_LOG" ||
    value === "CLAN_LEAD" ||
    value === "BOT_LOG" ||
    value === "CUSTOM" ||
    value === "DISABLED"
  ) {
    return value;
  }
  return null;
}

function getAllowedRoutingModes(
  type: RoutedBotLogChannelType,
): ReadonlySet<BaseSwapBotLogRoutingMode> {
  if (type === "ban-log") {
    return new Set<BaseSwapBotLogRoutingMode>([
      "BOT_LOG",
      "CUSTOM",
      "DISABLED",
    ]);
  }
  return new Set<BaseSwapBotLogRoutingMode>([
    "CLAN_LOG",
    "CLAN_LEAD",
    "BOT_LOG",
    "CUSTOM",
    "DISABLED",
  ]);
}

function getDefaultRoutingMode(
  type: RoutedBotLogChannelType,
): BaseSwapBotLogRoutingMode {
  return type === "ban-join-alert" ? "CLAN_LEAD" : "DISABLED";
}

function buildDefaultRoutedBotLogRoutingConfig(
  type: RoutedBotLogChannelType,
): RoutedBotLogRoutingConfig {
  return {
    routingMode: getDefaultRoutingMode(type),
    channelId: null,
    legacy: false,
    configured: false,
  };
}

function parseRoutedBotLogRoutingConfig(
  raw: string | null,
  type: RoutedBotLogChannelType,
): RoutedBotLogRoutingConfig {
  if (!raw) {
    return buildDefaultRoutedBotLogRoutingConfig(type);
  }

  try {
    const parsed = JSON.parse(raw) as {
      routingMode?: string | null;
      channelId?: string | null;
    };
    const routingMode = normalizeBaseSwapRoutingMode(parsed.routingMode);
    const allowedModes = getAllowedRoutingModes(type);
    if (!routingMode || !allowedModes.has(routingMode)) {
      return buildDefaultRoutedBotLogRoutingConfig(type);
    }

    return {
      routingMode,
      channelId: routingMode === "CUSTOM" ? normalizeChannelId(parsed.channelId) : null,
      legacy: false,
      configured: true,
    };
  } catch {
    return buildDefaultRoutedBotLogRoutingConfig(type);
  }
}

function parseBaseSwapRoutingConfig(
  raw: string | null,
): BaseSwapBotLogRoutingConfig | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as {
      routingMode?: string | null;
      channelId?: string | null;
    };
    const routingMode = normalizeBaseSwapRoutingMode(parsed.routingMode);
    if (!routingMode) return null;
    return {
      routingMode,
      channelId: routingMode === "CUSTOM" ? normalizeChannelId(parsed.channelId) : null,
      legacy: false,
    };
  } catch {
    return null;
  }
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
    type: SimpleBotLogChannelType,
  ): Promise<string | null> {
    const raw = await this.settings.get(botLogChannelKey(guildId, type));
    if (!raw) return null;
    const normalized = raw.trim();
    if (!/^\d+$/.test(normalized)) return null;
    return normalized;
  }

  /** Purpose: return persisted base-swap audit routing, preserving legacy typed channel rows as custom routing. */
  async getBaseSwapRoutingConfig(
    guildId: string,
  ): Promise<BaseSwapBotLogRoutingConfig | null> {
    const raw = await this.settings.get(baseSwapRoutingKey(guildId));
    const parsed = parseBaseSwapRoutingConfig(raw);
    if (parsed) return parsed;

    const legacyChannelId = await this.getChannelIdForType(guildId, "base-swap");
    if (legacyChannelId) {
      return {
        routingMode: "CUSTOM",
        channelId: legacyChannelId,
        legacy: true,
      };
    }
    return null;
  }

  /** Purpose: persist the base-swap audit routing config. */
  async setBaseSwapRoutingConfig(input: {
    guildId: string;
    routingMode: BaseSwapBotLogRoutingMode;
    channelId?: string | null;
  }): Promise<void> {
    const routingMode = normalizeBaseSwapRoutingMode(input.routingMode);
    if (!routingMode) throw new Error("INVALID_BASE_SWAP_BOT_LOG_ROUTING");
    const channelId = normalizeChannelId(input.channelId);
    if (routingMode === "CUSTOM" && !channelId) {
      throw new Error("INVALID_BASE_SWAP_BOT_LOG_CHANNEL");
    }
    if (routingMode !== "CUSTOM" && channelId) {
      throw new Error("INVALID_BASE_SWAP_BOT_LOG_CHANNEL");
    }
    await this.settings.set(
      baseSwapRoutingKey(input.guildId),
      JSON.stringify({
        routingMode,
        channelId: routingMode === "CUSTOM" ? channelId : null,
      }),
    );
  }

  /** Purpose: clear persisted base-swap audit routing config. */
  async clearBaseSwapRoutingConfig(guildId: string): Promise<void> {
    await this.settings.delete(baseSwapRoutingKey(guildId));
  }

  /** Purpose: load persisted routed bot-log config for ban-log or banned-join alerts. */
  async getRoutingConfigForType(
    guildId: string,
    type: RoutedBotLogChannelType,
  ): Promise<RoutedBotLogRoutingConfig> {
    const raw = await this.settings.get(routedBotLogRoutingKey(guildId, type));
    return parseRoutedBotLogRoutingConfig(raw, type);
  }

  /** Purpose: persist routed bot-log config for ban-log or banned-join alerts. */
  async setRoutingConfigForType(input: {
    guildId: string;
    type: RoutedBotLogChannelType;
    routingMode: BaseSwapBotLogRoutingMode;
    channelId?: string | null;
  }): Promise<void> {
    const allowedModes = getAllowedRoutingModes(input.type);
    const routingMode = normalizeBaseSwapRoutingMode(input.routingMode);
    if (!routingMode || !allowedModes.has(routingMode)) {
      throw new Error("INVALID_ROUTED_BOT_LOG_ROUTING");
    }

    const channelId = normalizeChannelId(input.channelId);
    if (routingMode === "CUSTOM" && !channelId) {
      throw new Error("INVALID_ROUTED_BOT_LOG_CHANNEL");
    }
    if (routingMode !== "CUSTOM" && channelId) {
      throw new Error("INVALID_ROUTED_BOT_LOG_CHANNEL");
    }

    await this.settings.set(
      routedBotLogRoutingKey(input.guildId, input.type),
      JSON.stringify({
        routingMode,
        channelId: routingMode === "CUSTOM" ? channelId : null,
      }),
    );
  }

  /** Purpose: clear routed bot-log config for ban-log or banned-join alerts. */
  async clearRoutingConfigForType(
    guildId: string,
    type: RoutedBotLogChannelType,
  ): Promise<void> {
    await this.settings.delete(routedBotLogRoutingKey(guildId, type));
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
    type: SimpleBotLogChannelType,
  ): Promise<void> {
    await this.settings.delete(botLogChannelKey(guildId, type));
  }
}

/** Purpose: share a single bot-log routing service instance across callers. */
export const botLogChannelService = new BotLogChannelService();
