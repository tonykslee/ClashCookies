import { ChannelType } from "discord.js";
import { LayoutAlertConfig, LayoutAlertMode, LayoutRecord, PrismaClient } from "@prisma/client";
import { prisma } from "../prisma";

export const LAYOUT_ALERT_STALE_AFTER_DAYS = 28;
export const LAYOUT_ALERT_TYPE_CHOICES = [
  { name: "None", value: "none" },
  { name: "DM", value: "dm" },
  { name: "Default channel", value: "default-channel" },
  { name: "DM + default channel", value: "both" },
  { name: "Custom channel", value: "custom-channel" },
] as const;

export type LayoutAlertType = (typeof LAYOUT_ALERT_TYPE_CHOICES)[number]["value"];
export type LayoutAlertPolicy = LayoutAlertConfig;

type LayoutAlertDb = Pick<PrismaClient, "layoutRecord" | "layoutAlertConfig">;

export type LayoutAlertConfigServiceOptions = {
  db?: LayoutAlertDb;
};

export class LayoutAlertPolicyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LayoutAlertPolicyValidationError";
  }
}

/** Purpose: parse the shared command-facing alert choices for both generic and FWA layout commands. */
export function parseLayoutAlertType(input: string | null | undefined): LayoutAlertType | null {
  if (input === null || input === undefined) return null;
  const normalized = input.trim().toLowerCase();
  if (LAYOUT_ALERT_TYPE_CHOICES.some((choice) => choice.value === normalized)) {
    return normalized as LayoutAlertType;
  }
  throw new LayoutAlertPolicyValidationError(
    "Invalid alert-type. Use none, dm, default-channel, both, or custom-channel.",
  );
}

/** Purpose: map command-facing alert choices to their durable policy mode. */
export function layoutAlertModeForType(type: Exclude<LayoutAlertType, "none">): LayoutAlertMode {
  if (type === "dm") return LayoutAlertMode.DM;
  if (type === "default-channel") return LayoutAlertMode.DEFAULT_CHANNEL;
  if (type === "both") return LayoutAlertMode.BOTH;
  return LayoutAlertMode.CUSTOM_CHANNEL;
}

/** Purpose: validate command routing inputs before layout persistence or publication work begins. */
export function validateLayoutAlertCommandOptions(input: {
  type: LayoutAlertType | null;
  channel: { id: string; guildId?: string | null; type?: number } | null;
  guildId: string;
  defaultChannelId?: string | null;
}): void {
  if (!input.type) {
    if (input.channel) {
      throw new LayoutAlertPolicyValidationError(
        "`alert-channel` requires `alert-type:custom-channel`.",
      );
    }
    return;
  }

  if (input.type !== "custom-channel" && input.channel) {
    throw new LayoutAlertPolicyValidationError(
      "`alert-channel` is only valid with `alert-type:custom-channel`.",
    );
  }
  if (input.type === "custom-channel") {
    if (!input.channel) {
      throw new LayoutAlertPolicyValidationError(
        "`alert-type:custom-channel` requires `alert-channel`.",
      );
    }
    if (input.channel.guildId !== input.guildId) {
      throw new LayoutAlertPolicyValidationError(
        "Selected alert channel must belong to the same server as the layout post.",
      );
    }
    if (!isSupportedLayoutAlertChannel(input.channel.type)) {
      throw new LayoutAlertPolicyValidationError(
        "Selected alert channel must be a server text, announcement, or thread channel.",
      );
    }
  }
  if ((input.type === "default-channel" || input.type === "both") && !input.defaultChannelId) {
    throw new LayoutAlertPolicyValidationError(
      "No layout-alerts channel is configured. Set one with `/bot-logs type:layout-alerts channel:<channel>`.",
    );
  }
}

/** Purpose: keep custom expiration-alert destinations limited to Discord text-capable guild channels. */
export function isSupportedLayoutAlertChannel(type: number | undefined): boolean {
  return type === ChannelType.GuildText ||
    type === ChannelType.GuildAnnouncement ||
    type === ChannelType.PublicThread ||
    type === ChannelType.PrivateThread;
}

/** Purpose: render the currently effective policy without copying guild routing into the policy owner. */
export function formatLayoutAlertPolicyLine(
  policy: LayoutAlertPolicy | null,
  defaultChannelId: string | null = null,
): string | null {
  if (!policy) return null;
  if (policy.mode === LayoutAlertMode.DM) return "Expiration alert: DM";
  if (policy.mode === LayoutAlertMode.DEFAULT_CHANNEL) {
    return defaultChannelId
      ? `Expiration alert: <#${defaultChannelId}>`
      : "Expiration alert: Default channel not configured";
  }
  if (policy.mode === LayoutAlertMode.BOTH) {
    return defaultChannelId
      ? `Expiration alert: DM + <#${defaultChannelId}>`
      : "Expiration alert: DM + Default channel not configured";
  }
  return `Expiration alert: <#${policy.customChannelId}>`;
}

/** Purpose: own durable per-layout alert policy without calculating eligibility or delivering alerts. */
export class LayoutAlertConfigService {
  private readonly db: LayoutAlertDb;

  constructor(options: LayoutAlertConfigServiceOptions = {}) {
    this.db = options.db ?? prisma;
  }

  async getPolicy(layoutId: string): Promise<LayoutAlertPolicy | null> {
    return this.db.layoutAlertConfig.findUnique({ where: { layoutId } });
  }

  async setPolicy(input: {
    layoutId: string;
    mode: LayoutAlertMode;
    customChannelId?: string | null;
  }): Promise<LayoutAlertPolicy> {
    const layout = await this.requireLayout(input.layoutId);
    validatePolicyShape(input.mode, input.customChannelId);
    validatePolicyPrerequisites(layout, input.mode);

    return this.db.layoutAlertConfig.upsert({
      where: { layoutId: input.layoutId },
      create: {
        layoutId: input.layoutId,
        mode: input.mode,
        customChannelId: normalizeChannelId(input.customChannelId),
      },
      update: {
        mode: input.mode,
        customChannelId: normalizeChannelId(input.customChannelId),
      },
    });
  }

  async disablePolicy(layoutId: string): Promise<void> {
    await this.requireLayout(layoutId);
    await this.db.layoutAlertConfig.deleteMany({ where: { layoutId } });
  }

  private async requireLayout(layoutId: string): Promise<LayoutRecord> {
    const layout = await this.db.layoutRecord.findUnique({ where: { id: layoutId } });
    if (!layout) {
      throw new LayoutAlertPolicyValidationError(`Layout record was not found: ${layoutId}`);
    }
    return layout;
  }
}

function normalizeChannelId(input: string | null | undefined): string | null {
  const value = String(input ?? "").trim();
  return value && /^\d+$/.test(value) ? value : null;
}

function validatePolicyShape(mode: LayoutAlertMode, customChannelId: string | null | undefined): void {
  const normalizedChannelId = normalizeChannelId(customChannelId);
  if (mode === LayoutAlertMode.CUSTOM_CHANNEL && !normalizedChannelId) {
    throw new LayoutAlertPolicyValidationError(
      "Custom-channel expiration alerts require a Discord channel.",
    );
  }
  if (mode !== LayoutAlertMode.CUSTOM_CHANNEL && normalizedChannelId) {
    throw new LayoutAlertPolicyValidationError(
      "Only custom-channel expiration alerts may store a custom channel.",
    );
  }
}

function validatePolicyPrerequisites(layout: LayoutRecord, mode: LayoutAlertMode): void {
  if (!layout.discordGuildId || !layout.discordChannelId || !layout.discordMessageId) {
    throw new LayoutAlertPolicyValidationError(
      "A canonical Discord layout post is required before enabling expiration alerts.",
    );
  }
  if ((mode === LayoutAlertMode.DM || mode === LayoutAlertMode.BOTH) && !layout.postedByDiscordUserId) {
    throw new LayoutAlertPolicyValidationError(
      "This legacy layout has no recorded poster, so DM alerts are unavailable. Use a channel alert or submit a new layout link.",
    );
  }
}

export const layoutAlertConfigService = new LayoutAlertConfigService();
