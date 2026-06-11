import {
  ButtonInteraction,
  EmbedBuilder,
} from "discord.js";
import { formatError } from "../helper/formatError";
import { prisma } from "../prisma";
import {
  buildFwaTrackedClanMinimalListRender,
  loadFwaTrackedClanMinimalListState,
} from "./TrackedClanListService";
import {
  parseSyncTimeMetadata,
  TRACKED_MESSAGE_FEATURE_TYPE,
  TRACKED_MESSAGE_STATUS,
  trackedMessageService,
  type SyncTimeTrackedMetadata,
} from "./TrackedMessageService";

const SYNC_TIME_FWA_CLAN_LIST_REFRESH_BUTTON_PREFIX = "sync-time:fwa-clan-list";
export const SYNC_TIME_FWA_CLAN_LIST_REFRESH_BUTTON_CUSTOM_ID =
  `${SYNC_TIME_FWA_CLAN_LIST_REFRESH_BUTTON_PREFIX}:refresh`;
const SYNC_TIME_FWA_CLAN_LIST_REFRESH_WINDOW_MS = 24 * 60 * 60 * 1000;

export type SyncTimeFwaClanListMessagePayload = {
  content: string;
  embeds: EmbedBuilder[];
  components: ReturnType<typeof buildFwaTrackedClanMinimalListRender>["components"];
  metadata: SyncTimeTrackedMetadata;
  trackedClanCount: number;
};

function buildSyncTimeMessageContent(epochSeconds: number, roleId: string): string {
  return `# Sync time :gem:\n\n<t:${epochSeconds}:F> (<t:${epochSeconds}:R>)\n\n<@&${roleId}>`;
}

function parseOptionalIsoDate(input: string | null | undefined): Date | null {
  const normalized = String(input ?? "").trim();
  if (!normalized) return null;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? new Date(parsed) : null;
}

function buildRefreshWindowExpiresAt(now: Date): Date {
  return new Date(now.getTime() + SYNC_TIME_FWA_CLAN_LIST_REFRESH_WINDOW_MS);
}

function buildSyncTimeFwaClanListMetadata(input: {
  baseMetadata: SyncTimeTrackedMetadata;
  now: Date;
  refreshExpiresAt: Date;
}): SyncTimeTrackedMetadata {
  return {
    ...input.baseMetadata,
    fwaClanListEnabled: true,
    fwaClanListRefreshExpiresAtIso: input.refreshExpiresAt.toISOString(),
    fwaClanListLastRefreshedAtIso: input.now.toISOString(),
  };
}

export async function buildSyncTimeFwaClanListMessagePayload(input: {
  baseMetadata: SyncTimeTrackedMetadata;
  guildId?: string | null;
  now?: Date;
  refreshExpiresAt?: Date | null;
}): Promise<SyncTimeFwaClanListMessagePayload> {
  const now = input.now ?? new Date();
  const refreshExpiresAt = input.refreshExpiresAt ?? buildRefreshWindowExpiresAt(now);
  const state = await loadFwaTrackedClanMinimalListState();
  const render = buildFwaTrackedClanMinimalListRender({
    refreshPrefix: SYNC_TIME_FWA_CLAN_LIST_REFRESH_BUTTON_PREFIX,
    trackedClans: state.trackedClans,
    memberCountByTag: state.memberCountByTag,
    refreshing: false,
  });

  console.info(
    `[sync-time-fwa-list] rendered guild_id=${String(input.guildId ?? "").trim() || "unknown"} tracked_clan_count=${state.trackedClans.length} refresh_expires_at=${refreshExpiresAt.toISOString()}`,
  );

  return {
    content: buildSyncTimeMessageContent(
      input.baseMetadata.syncEpochSeconds,
      input.baseMetadata.roleId,
    ),
    embeds: render.embeds,
    components: render.components,
    metadata: buildSyncTimeFwaClanListMetadata({
      baseMetadata: input.baseMetadata,
      now,
      refreshExpiresAt,
    }),
    trackedClanCount: state.trackedClans.length,
  };
}

function isFwaClanListRefreshWindowExpired(metadata: SyncTimeTrackedMetadata, now: Date): boolean {
  const expiresAt = parseOptionalIsoDate(metadata.fwaClanListRefreshExpiresAtIso ?? null);
  return !expiresAt || expiresAt.getTime() <= now.getTime();
}

export function isSyncTimeFwaClanListRefreshButtonCustomId(customId: string): boolean {
  return String(customId ?? "").trim() === SYNC_TIME_FWA_CLAN_LIST_REFRESH_BUTTON_CUSTOM_ID;
}

export async function handleSyncTimeFwaClanListRefreshButton(
  interaction: ButtonInteraction,
): Promise<void> {
  if (!isSyncTimeFwaClanListRefreshButtonCustomId(interaction.customId)) return;

  if (!interaction.inGuild() || !interaction.guildId) {
    await interaction.reply({
      ephemeral: true,
      content: "This button can only be used in a server.",
    });
    return;
  }

  const tracked = await trackedMessageService.fetchSyncTrackedMessageWithClaims(interaction.message.id);
  const metadata = tracked ? parseSyncTimeMetadata(tracked.metadata) : null;
  const now = new Date();
  if (
    !tracked ||
    tracked.guildId !== interaction.guildId ||
    tracked.featureType !== TRACKED_MESSAGE_FEATURE_TYPE.SYNC_TIME_POST ||
    tracked.status === TRACKED_MESSAGE_STATUS.DELETED ||
    tracked.status === TRACKED_MESSAGE_STATUS.REPLACED ||
    !metadata ||
    metadata.fwaClanListEnabled !== true
  ) {
    await interaction.reply({
      ephemeral: true,
      content: "Could not refresh the FWA clan list for that sync-time post.",
    });
    return;
  }

  if (isFwaClanListRefreshWindowExpired(metadata, now)) {
    console.info(
      `[sync-time-fwa-list] refresh_expired guild_id=${interaction.guildId} message_id=${interaction.message.id} expires_at=${metadata.fwaClanListRefreshExpiresAtIso ?? "missing"} now=${now.toISOString()}`,
    );
    await interaction.reply({
      ephemeral: true,
      content: "The FWA clan-list refresh window has expired.",
    });
    return;
  }

  await interaction.deferUpdate();

  try {
    const payload = await buildSyncTimeFwaClanListMessagePayload({
      baseMetadata: metadata,
      guildId: tracked.guildId,
      now,
      refreshExpiresAt: parseOptionalIsoDate(metadata.fwaClanListRefreshExpiresAtIso ?? null),
    });

    await interaction.message.edit({
      content: payload.content,
      embeds: payload.embeds,
      components: payload.components,
    });

    await prisma.trackedMessage.update({
      where: { messageId: tracked.messageId },
      data: {
        metadata: payload.metadata as any,
      },
    });

    console.info(
      `[sync-time-fwa-list] refresh_success guild_id=${interaction.guildId} message_id=${tracked.messageId} tracked_clan_count=${payload.trackedClanCount}`,
    );
  } catch (err) {
    console.error(
      `[sync-time-fwa-list] refresh_failed guild_id=${interaction.guildId} message_id=${tracked.messageId} error=${formatError(err)}`,
    );
    await interaction.followUp({
      ephemeral: true,
      content: "Failed to refresh the FWA clan list.",
    });
  }
}
