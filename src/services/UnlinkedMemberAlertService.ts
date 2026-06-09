import { ClanWar } from "../generated/coc-api";
import { formatError } from "../helper/formatError";
import { prisma } from "../prisma";
import { type CoCService } from "./CoCService";
import { resolveCurrentCwlSeasonKey } from "./CwlRegistryService";
import {
  buildActiveCwlClanByPlayerTag,
  loadActiveCwlWarsByClan,
} from "./TodoSnapshotService";
import {
  normalizeClanTag,
  normalizeDiscordUserId,
  normalizePlayerTag,
} from "./PlayerLinkService";
import { botLogChannelService } from "./BotLogChannelService";
import { BanRecord, BanTargetKind } from "@prisma/client";

type DiscordClientLike = {
  guilds: {
    cache: Map<string, unknown> | { get: (id: string) => unknown };
    fetch: (id: string) => Promise<unknown>;
  };
};

type ObservedFwaClan = {
  clanTag: string;
  clanName: string;
  logChannelId: string | null;
  members: Array<{
    playerTag: string;
    playerName: string;
  }>;
};

type LiveTrackedClanMember = {
  playerTag: string;
  playerName: string;
  clanTag: string;
  clanName: string;
  logChannelId: string | null;
};

export const UNLINKED_DB_STAGE_TIMEOUT_MS = 5_000;
export const UNLINKED_EXTERNAL_STAGE_TIMEOUT_MS = 15_000;

export type CurrentUnlinkedTrackedMember = {
  playerTag: string;
  playerName: string;
  clanTag: string;
  clanName: string;
};

export type PersistedUnlinkedTrackedMember = {
  playerTag: string;
  playerName: string;
  clanTag: string;
  clanName: string;
};

type UnlinkedStageDetailValue = string | number | boolean | null | undefined;

type UnlinkedStageDetails = Record<string, UnlinkedStageDetailValue>;

export class UnlinkedStageTimeoutError extends Error {
  readonly stage: string;
  readonly timeoutMs: number;

  constructor(stage: string, timeoutMs: number, details?: string) {
    super(
      details
        ? `Unlinked stage timed out: ${stage} after ${timeoutMs}ms (${details})`
        : `Unlinked stage timed out: ${stage} after ${timeoutMs}ms`,
    );
    this.name = "UnlinkedStageTimeoutError";
    this.stage = stage;
    this.timeoutMs = timeoutMs;
  }
}

function formatStageDetails(details?: UnlinkedStageDetails): string {
  if (!details) return "";
  const parts = Object.entries(details)
    .map(([key, value]) => `${key}=${String(value)}`)
    .filter((value) => !value.endsWith("=undefined"));
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

async function runBoundedUnlinkedStage<T>(input: {
  stage: string;
  timeoutMs: number;
  details?: UnlinkedStageDetails;
  action: () => Promise<T>;
}): Promise<T> {
  const startedAtMs = Date.now();
  const detailText = formatStageDetails(input.details);
  console.info(
    `[unlinked] stage=${input.stage} status=started timeout_ms=${input.timeoutMs}${detailText}`,
  );

  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(
          new UnlinkedStageTimeoutError(
            input.stage,
            input.timeoutMs,
            detailText.trim(),
          ),
        );
      }, input.timeoutMs);
    });
    const result = (await Promise.race([
      input.action(),
      timeoutPromise,
    ])) as T;
    console.info(
      `[unlinked] stage=${input.stage} status=completed duration_ms=${
        Date.now() - startedAtMs
      }${detailText}`,
    );
    return result;
  } catch (err) {
    const timeout = err instanceof UnlinkedStageTimeoutError;
    const level = timeout ? console.error : console.error;
    level(
      `[unlinked] stage=${input.stage} status=${timeout ? "timeout" : "failed"} duration_ms=${
        Date.now() - startedAtMs
      } timeout_ms=${input.timeoutMs}${detailText}${
        timeout ? "" : ` error=${formatError(err)}`
      }`,
    );
    throw err;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

export function buildUnlinkedAlertContent(input: {
  playerName: string;
  playerTag: string;
  clanName: string;
}): string {
  return `An unlinked player, ${input.playerName} (\`${input.playerTag}\`), has joined **${input.clanName}**.`;
}

function buildBannedPlayerJoinAlertContent(input: {
  playerName: string;
  playerTag: string;
  clanName: string;
  ban: {
    targetKind: BanTargetKind;
    discordUserId: string | null;
    reason: string | null;
    expiresAt: Date | null;
  };
}): string {
  const banDescription =
    input.ban.targetKind === BanTargetKind.PLAYER
      ? "direct player ban"
      : `Discord user ban ${input.ban.discordUserId ? `<@${input.ban.discordUserId}>` : "(unknown)"}`;
  const reason = normalizeDisplayText(input.ban.reason, "No reason provided");
  const expiresAt =
    input.ban.expiresAt !== null
      ? `<t:${Math.floor(input.ban.expiresAt.getTime() / 1000)}:R>`
      : "Indefinite";
  return [
    `A banned player, ${input.playerName} (\`${input.playerTag}\`), has joined **${input.clanName}**.`,
    `Ban: ${banDescription}`,
    `Reason: ${reason}`,
    `Expires: ${expiresAt}`,
  ].join("\n");
}

type BannedPlayerJoinAlertRecord = {
  playerTag: string;
  clanTag: string;
  alertedAt?: Date | null;
  playerName?: string;
  clanName?: string;
  banRecordId?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
};

const bannedPlayerJoinAlertTable = prisma as typeof prisma & {
  bannedPlayerJoinAlert: {
    findMany: (args: {
      where: { guildId: string };
      select?: { playerTag: true; clanTag: true } | null;
      orderBy?: unknown;
    }) => Promise<BannedPlayerJoinAlertRecord[]>;
    deleteMany: (args: {
      where: { guildId: string; OR: Array<{ playerTag: string; clanTag: string }> };
    }) => Promise<{ count: number }>;
    upsert: (args: unknown) => Promise<unknown>;
    update: (args: unknown) => Promise<unknown>;
  };
};

function normalizeGuildId(input: string): string {
  return String(input ?? "").trim();
}

function normalizeChannelId(input: string | null | undefined): string | null {
  const trimmed = String(input ?? "").trim();
  return /^\d+$/.test(trimmed) ? trimmed : null;
}

export type UnlinkedAlertRoutingMode =
  | "CLAN_LOG"
  | "CLAN_LEAD"
  | "BOT_LOG"
  | "CUSTOM"
  | "DISABLED";

export type UnlinkedAlertRoutingConfig = {
  routingMode: UnlinkedAlertRoutingMode;
  channelId: string | null;
};

type AlertChannelCandidate = {
  channelId: string | null;
  source: "clan_log" | "clan_lead" | "bot_log" | "custom";
};

/** Purpose: normalize the persisted explicit routing mode for unlinked alerts. */
function normalizeUnlinkedAlertRoutingMode(
  input: string | null | undefined,
): UnlinkedAlertRoutingMode | null {
  const normalized = String(input ?? "").trim().toUpperCase();
  if (
    normalized === "CLAN_LOG" ||
    normalized === "CLAN_LEAD" ||
    normalized === "BOT_LOG" ||
    normalized === "CUSTOM" ||
    normalized === "DISABLED"
  ) {
    return normalized;
  }
  return null;
}

/** Purpose: preserve legacy custom rows while defaulting missing configs to clan-log routing. */
function resolveLegacyUnlinkedAlertRoutingMode(input: {
  routingMode?: string | null;
  channelId?: string | null;
} | null): UnlinkedAlertRoutingMode {
  const normalizedRoutingMode = normalizeUnlinkedAlertRoutingMode(
    input?.routingMode ?? null,
  );
  if (normalizedRoutingMode) {
    return normalizedRoutingMode;
  }
  return normalizeChannelId(input?.channelId) ? "CUSTOM" : "CLAN_LOG";
}

function normalizeDisplayText(input: string | null | undefined, fallback: string): string {
  const normalized = String(input ?? "").replace(/\s+/g, " ").trim();
  return normalized || fallback;
}

function buildBannedJoinAlertKey(input: { playerTag: string; clanTag: string }): string {
  return `${normalizePlayerTag(input.playerTag)}::${normalizeClanTag(input.clanTag)}`;
}

function getGuildFromClient(client: DiscordClientLike, guildId: string): unknown | null {
  const cache = client.guilds.cache;
  if (cache instanceof Map) {
    return cache.get(guildId) ?? null;
  }
  if (cache && typeof cache.get === "function") {
    return cache.get(guildId) ?? null;
  }
  return null;
}

async function resolveGuildFromClient(
  client: DiscordClientLike,
  guildId: string,
): Promise<{
  channels?: {
    cache?: Map<string, unknown> | { get: (id: string) => unknown };
    fetch?: (id: string) => Promise<unknown>;
  };
} | null> {
  const cached = getGuildFromClient(client, guildId);
  if (cached) return cached as any;
  try {
    return (await client.guilds.fetch(guildId)) as any;
  } catch {
    return null;
  }
}

async function resolveSendableGuildChannel(input: {
  client: DiscordClientLike;
  guildId: string;
  channelId: string;
}): Promise<{ send: (payload: { content: string; allowedMentions: { parse: never[] } }) => Promise<unknown> } | null> {
  const guild = await resolveGuildFromClient(input.client, input.guildId);
  if (!guild?.channels) return null;

  const channelCache = guild.channels.cache;
  let channel: unknown | null = null;
  if (channelCache instanceof Map) {
    channel = channelCache.get(input.channelId) ?? null;
  } else if (channelCache && typeof channelCache.get === "function") {
    channel = channelCache.get(input.channelId) ?? null;
  }

  if (!channel && typeof guild.channels.fetch === "function") {
    channel = await guild.channels.fetch(input.channelId).catch(() => null);
  }
  if (!channel || typeof (channel as { send?: unknown }).send !== "function") {
    return null;
  }
  return channel as {
    send: (payload: { content: string; allowedMentions: { parse: never[] } }) => Promise<unknown>;
  };
}

async function loadTrackedClanAlertChannelsByTag(): Promise<{
  logChannelByTag: Map<string, string | null>;
  leaderChannelByTag: Map<string, string | null>;
}> {
  const trackedClans = await runBoundedUnlinkedStage({
    stage: "tracked_clan_log_channel_query",
    timeoutMs: UNLINKED_DB_STAGE_TIMEOUT_MS,
    action: () =>
      prisma.trackedClan.findMany({
        orderBy: [{ createdAt: "asc" }, { tag: "asc" }],
        select: {
          tag: true,
          logChannelId: true,
          leaderChannelId: true,
        },
      }),
  });
  return {
    logChannelByTag: new Map(
      trackedClans.map((row) => [
        normalizeClanTag(row.tag),
        normalizeChannelId(row.logChannelId),
      ] as const),
    ),
    leaderChannelByTag: new Map(
      trackedClans.map((row) => [
        normalizeClanTag(row.tag),
        normalizeChannelId(row.leaderChannelId),
      ] as const),
    ),
  };
}

async function loadLiveFwaMembers(input: {
  cocService: CoCService;
  trackedClanLogChannelByTag?: Map<string, string | null>;
  observedFwaClans?: ObservedFwaClan[];
}): Promise<LiveTrackedClanMember[]> {
  const observed = input.observedFwaClans;
  if (observed && observed.length > 0) {
    return observed.flatMap((clan) => {
      const clanTag = normalizeClanTag(clan.clanTag);
      if (!clanTag) return [];
      const clanName = normalizeDisplayText(clan.clanName, clanTag);
      const logChannelId =
        normalizeChannelId(clan.logChannelId) ??
        input.trackedClanLogChannelByTag?.get(clanTag) ??
        null;
      return clan.members
        .map((member) => {
          const playerTag = normalizePlayerTag(member.playerTag);
          if (!playerTag) return null;
          return {
            playerTag,
            playerName: normalizeDisplayText(member.playerName, playerTag),
            clanTag,
            clanName,
            logChannelId,
          };
        })
      .filter((value): value is LiveTrackedClanMember => value !== null);
    });
  }

  const trackedClans = await runBoundedUnlinkedStage({
    stage: "tracked_clan_members_query",
    timeoutMs: UNLINKED_DB_STAGE_TIMEOUT_MS,
    action: () =>
      prisma.trackedClan.findMany({
        orderBy: [{ createdAt: "asc" }, { tag: "asc" }],
        select: {
          tag: true,
          name: true,
          logChannelId: true,
        },
      }),
  });

  const clans = await Promise.all(
    trackedClans.map(async (tracked) => {
      const clanTag = normalizeClanTag(tracked.tag);
      if (!clanTag) return null;
      const clan = await runBoundedUnlinkedStage({
        stage: "fwa_member_fetch",
        timeoutMs: UNLINKED_EXTERNAL_STAGE_TIMEOUT_MS,
        details: { clan: clanTag },
        action: () => input.cocService.getClan(tracked.tag),
      });
      return {
        clanTag,
        clanName: normalizeDisplayText(
          String(clan?.name ?? tracked.name ?? ""),
          clanTag || tracked.tag,
        ),
        logChannelId:
          normalizeChannelId(tracked.logChannelId) ??
          input.trackedClanLogChannelByTag?.get(clanTag) ??
          null,
        members: Array.isArray(clan?.members) ? clan.members : [],
      };
    }),
  );
  console.info(
    `[unlinked] stage=tracked_clan_members_summary clan_count=${trackedClans.length} live_clan_count=${clans.filter((clan) => clan?.clanTag).length}`,
  );

  return clans.flatMap((clan) => {
    if (!clan?.clanTag) return [];
    return clan.members
      .map((member: { tag?: string | null; name?: string | null }) => {
        const playerTag = normalizePlayerTag(String(member?.tag ?? ""));
        if (!playerTag) return null;
        return {
          playerTag,
          playerName: normalizeDisplayText(String(member?.name ?? ""), playerTag),
          clanTag: clan.clanTag,
          clanName: clan.clanName,
          logChannelId: clan.logChannelId,
        };
      })
      .filter(
        (value: LiveTrackedClanMember | null): value is LiveTrackedClanMember => value !== null,
      );
  });
}

function resolveTrackedCwlSideMembers(input: {
  trackedCwlTag: string;
  war: ClanWar | null;
}): Array<{ playerTag: string; playerName: string; clanName: string }> {
  if (!input.war) return [];

  const clanTag = normalizeClanTag(String(input.war.clan?.tag ?? ""));
  const opponentTag = normalizeClanTag(String(input.war.opponent?.tag ?? ""));
  const trackedTag = normalizeClanTag(input.trackedCwlTag);
  const trackedSide =
    clanTag === trackedTag
      ? input.war.clan
      : opponentTag === trackedTag
        ? input.war.opponent
        : null;
  if (!trackedSide) return [];

  const clanName = normalizeDisplayText(String(trackedSide.name ?? ""), trackedTag);
  const members = Array.isArray(trackedSide.members) ? trackedSide.members : [];
  return members
    .map((member) => {
      const playerTag = normalizePlayerTag(String(member?.tag ?? ""));
      if (!playerTag) return null;
      return {
        playerTag,
        playerName: normalizeDisplayText(String(member?.name ?? ""), playerTag),
        clanName,
      };
    })
    .filter((value): value is { playerTag: string; playerName: string; clanName: string } => value !== null);
}

async function loadLiveCwlMembers(input: {
  cocService: CoCService;
  trackedClanLogChannelByTag?: Map<string, string | null>;
}): Promise<LiveTrackedClanMember[]> {
  const season = resolveCurrentCwlSeasonKey();
  const cwlTrackedClans = await runBoundedUnlinkedStage({
    stage: "cwl_tracked_clan_query",
    timeoutMs: UNLINKED_DB_STAGE_TIMEOUT_MS,
    details: { season },
    action: () =>
      prisma.cwlTrackedClan.findMany({
        where: { season },
        orderBy: [{ createdAt: "asc" }, { tag: "asc" }],
        select: {
          tag: true,
          name: true,
        },
      }),
  });
  const trackedTags = cwlTrackedClans
    .map((row) => normalizeClanTag(row.tag))
    .filter(Boolean);
  console.info(
    `[unlinked] stage=cwl_tracked_clan_summary season=${season} tracked_clan_count=${trackedTags.length}`,
  );
  if (trackedTags.length <= 0) return [];

  const warsByClan = await runBoundedUnlinkedStage({
    stage: "cwl_war_fetch",
    timeoutMs: UNLINKED_EXTERNAL_STAGE_TIMEOUT_MS,
    details: { season, clan_count: trackedTags.length },
    action: () => loadActiveCwlWarsByClan(input.cocService, trackedTags),
  });
  const activeMembersByPlayerTag = buildActiveCwlClanByPlayerTag({
    cwlWarByClan: warsByClan,
    trackedCwlTags: new Set(trackedTags),
  });
  console.info(
    `[unlinked] stage=cwl_war_fetch_summary season=${season} tracked_clan_count=${trackedTags.length} active_member_count=${activeMembersByPlayerTag.size}`,
  );

  return cwlTrackedClans.flatMap((tracked) => {
    const clanTag = normalizeClanTag(tracked.tag);
    if (!clanTag) return [];
    const members = resolveTrackedCwlSideMembers({
      trackedCwlTag: clanTag,
      war: warsByClan.get(clanTag) ?? null,
    });
    return members
      .filter((member) => activeMembersByPlayerTag.get(member.playerTag) === clanTag)
      .map((member) => ({
        playerTag: member.playerTag,
        playerName: member.playerName,
        clanTag,
        clanName: normalizeDisplayText(member.clanName, tracked.name ?? clanTag),
        logChannelId: input.trackedClanLogChannelByTag?.get(clanTag) ?? null,
      }));
  });
}

function dedupeTrackedMembers(
  members: LiveTrackedClanMember[],
  clanFilterTag?: string | null,
): LiveTrackedClanMember[] {
  const normalizedFilter = normalizeClanTag(clanFilterTag ?? "");
  const byPlayerTag = new Map<string, LiveTrackedClanMember>();
  for (const member of members) {
    if (normalizedFilter && member.clanTag !== normalizedFilter) continue;
    if (!byPlayerTag.has(member.playerTag)) {
      byPlayerTag.set(member.playerTag, member);
    }
  }
  return [...byPlayerTag.values()];
}

export class UnlinkedMemberAlertService {
  /** Purpose: persist one guild-level unlinked-alert routing configuration in the feature-owned table. */
  async setAlertRoutingConfig(input: {
    guildId: string;
    routingMode: UnlinkedAlertRoutingMode;
    channelId?: string | null;
  }): Promise<void> {
    const guildId = normalizeGuildId(input.guildId);
    const routingMode = normalizeUnlinkedAlertRoutingMode(input.routingMode);
    if (!guildId || !routingMode) {
      throw new Error("INVALID_UNLINKED_ALERT_CONFIG");
    }
    const channelId = normalizeChannelId(input.channelId ?? null);
    if (routingMode === "CUSTOM" && !channelId) {
      throw new Error("INVALID_UNLINKED_ALERT_CHANNEL");
    }
    if (routingMode !== "CUSTOM" && channelId) {
      throw new Error("INVALID_UNLINKED_ALERT_CHANNEL");
    }
    const persistedChannelId = routingMode === "CUSTOM" ? channelId : null;

    await prisma.unlinkedAlertConfig.upsert({
      where: { guildId },
      create: {
        guildId,
        routingMode,
        channelId: persistedChannelId,
      },
      update: {
        routingMode,
        channelId: persistedChannelId,
      },
    });
  }

  /** Purpose: return the persisted guild-level unlinked-alert routing configuration. */
  async getAlertRoutingConfig(guildId: string): Promise<UnlinkedAlertRoutingConfig> {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!normalizedGuildId) {
      return {
        routingMode: "CLAN_LOG",
        channelId: null,
      };
    }

    const row = await prisma.unlinkedAlertConfig.findUnique({
      where: { guildId: normalizedGuildId },
      select: {
        routingMode: true,
        channelId: true,
      },
    });
    const routingMode = resolveLegacyUnlinkedAlertRoutingMode(row);
    return {
      routingMode,
      channelId:
        routingMode === "CUSTOM" ? normalizeChannelId(row?.channelId) : null,
    };
  }

  /** Purpose: persist one guild-level unlinked alert channel in the feature-owned table. */
  async setAlertChannelId(input: { guildId: string; channelId: string }): Promise<void> {
    await this.setAlertRoutingConfig({
      guildId: input.guildId,
      routingMode: "CUSTOM",
      channelId: input.channelId,
    });
  }

  /** Purpose: return the configured guild-level unlinked alert channel when valid. */
  async getAlertChannelId(guildId: string): Promise<string | null> {
    const routingConfig = await this.getAlertRoutingConfig(guildId);
    return routingConfig.routingMode === "CUSTOM" ? routingConfig.channelId : null;
  }

  /** Purpose: resolve the current live tracked-member set across tracked FWA and active CWL clans. */
  async listCurrentTrackedMembers(input: {
    cocService: CoCService;
    clanTag?: string | null;
    observedFwaClans?: ObservedFwaClan[];
  }): Promise<CurrentUnlinkedTrackedMember[]> {
    const [fwaMembers, cwlMembers] = await Promise.all([
      loadLiveFwaMembers({
        cocService: input.cocService,
        observedFwaClans: input.observedFwaClans,
      }),
      loadLiveCwlMembers({
        cocService: input.cocService,
      }),
    ]);

    return dedupeTrackedMembers([...fwaMembers, ...cwlMembers], input.clanTag ?? null);
  }

  /** Purpose: resolve the current live unlinked-member set across tracked FWA and active CWL clans. */
  async listCurrentUnlinkedMembers(input: {
    guildId: string;
    cocService: CoCService;
    clanTag?: string | null;
    observedFwaClans?: ObservedFwaClan[];
  }): Promise<CurrentUnlinkedTrackedMember[]> {
    const guildId = normalizeGuildId(input.guildId);
    if (!guildId) return [];

    const currentMembers = await this.listCurrentTrackedMembers({
      cocService: input.cocService,
      clanTag: input.clanTag ?? null,
      observedFwaClans: input.observedFwaClans,
    });
    if (currentMembers.length <= 0) {
      return [];
    }

    const linkedRows = await runBoundedUnlinkedStage({
      stage: "player_link_query",
      timeoutMs: UNLINKED_DB_STAGE_TIMEOUT_MS,
      details: {
        guild: guildId,
        player_count: currentMembers.length,
      },
      action: () =>
        prisma.playerLink.findMany({
          where: {
            playerTag: { in: currentMembers.map((member) => member.playerTag) },
          },
          select: {
            playerTag: true,
            discordUserId: true,
          },
        }),
    });
    console.info(
      `[unlinked] stage=player_link_query_summary guild=${guildId} player_count=${currentMembers.length} row_count=${linkedRows.length}`,
    );
    const linkedTagSet = new Set(
      linkedRows
        .filter((row) => normalizeDiscordUserId(row.discordUserId) !== null)
        .map((row) => normalizePlayerTag(row.playerTag))
        .filter(Boolean),
    );

    const unresolvedMembers = currentMembers.filter(
      (member) => !linkedTagSet.has(member.playerTag),
    );
    console.info(
      `[unlinked] stage=current_unlinked_summary guild=${guildId} current_member_count=${currentMembers.length} unresolved_count=${unresolvedMembers.length}`,
    );

    return unresolvedMembers.map((member) => ({
        playerTag: member.playerTag,
        playerName: member.playerName,
        clanTag: member.clanTag,
        clanName: member.clanName,
      }));
  }

  /** Purpose: read the persisted unresolved unlinked-member snapshot for a guild. */
  async listPersistedUnlinkedMembers(input: {
    guildId: string;
    clanTag?: string | null;
  }): Promise<PersistedUnlinkedTrackedMember[]> {
    const guildId = normalizeGuildId(input.guildId);
    if (!guildId) return [];

    const normalizedClanTag = normalizeClanTag(input.clanTag ?? "");
    const rows = await runBoundedUnlinkedStage({
      stage: "persisted_unlinked_query",
      timeoutMs: UNLINKED_DB_STAGE_TIMEOUT_MS,
      details: {
        guild: guildId,
        clan: normalizedClanTag || "all",
      },
      action: () =>
        prisma.unlinkedPlayer.findMany({
          where: {
            guildId,
            ...(normalizedClanTag ? { clanTag: normalizedClanTag } : {}),
          },
          orderBy: [{ createdAt: "asc" }, { playerTag: "asc" }],
          select: {
            playerTag: true,
            playerName: true,
            clanTag: true,
            clanName: true,
          },
        }),
    });
    console.info(
      `[unlinked] stage=persisted_unlinked_query_summary guild=${guildId} clan=${normalizedClanTag || "all"} row_count=${rows.length}`,
    );
    return rows.flatMap((row) => {
      const playerTag = normalizePlayerTag(row.playerTag);
      const clanTag = normalizeClanTag(row.clanTag);
      if (!playerTag || !clanTag) return [];
      return [
        {
          playerTag,
          playerName: normalizeDisplayText(row.playerName, playerTag),
          clanTag,
          clanName: normalizeDisplayText(row.clanName, clanTag),
        },
      ];
    });
  }

  /** Purpose: reconcile persisted unresolved state with the current live unlinked-member set and send first-seen alerts once. */
  async reconcileGuildAlerts(input: {
    client: DiscordClientLike;
    guildId: string;
    cocService: CoCService;
    observedFwaClans?: ObservedFwaClan[];
  }): Promise<{
    unresolvedCount: number;
    alertedCount: number;
    resolvedCount: number;
  }> {
    const guildId = normalizeGuildId(input.guildId);
    if (!guildId) {
      return { unresolvedCount: 0, alertedCount: 0, resolvedCount: 0 };
    }

    const trackedClanAlertChannelsByTag = await loadTrackedClanAlertChannelsByTag();
    const trackedClanLogChannelByTag = trackedClanAlertChannelsByTag.logChannelByTag;
    const [fwaMembers, cwlMembers, routingConfig, existingRows] =
      await Promise.all([
        loadLiveFwaMembers({
          cocService: input.cocService,
          trackedClanLogChannelByTag,
          observedFwaClans: input.observedFwaClans,
        }),
        loadLiveCwlMembers({
          cocService: input.cocService,
          trackedClanLogChannelByTag,
        }),
        this.getAlertRoutingConfig(guildId),
        prisma.unlinkedPlayer.findMany({
          where: { guildId },
          orderBy: [{ createdAt: "asc" }, { playerTag: "asc" }],
        }),
      ]);
    const botLogChannelId =
      routingConfig.routingMode === "BOT_LOG"
        ? await botLogChannelService.getChannelId(guildId)
        : null;

    const currentMembers = dedupeTrackedMembers([...fwaMembers, ...cwlMembers]);
    const linkedRows =
      currentMembers.length > 0
        ? await runBoundedUnlinkedStage({
            stage: "player_link_query",
            timeoutMs: UNLINKED_DB_STAGE_TIMEOUT_MS,
            details: {
              guild: guildId,
              player_count: currentMembers.length,
            },
            action: () =>
              prisma.playerLink.findMany({
                where: {
                  playerTag: { in: currentMembers.map((member) => member.playerTag) },
                },
                select: {
                  playerTag: true,
                  discordUserId: true,
                },
              }),
          })
        : [];
    const linkedTagSet = new Set(
      linkedRows
        .filter((row) => normalizeDiscordUserId(row.discordUserId) !== null)
        .map((row) => normalizePlayerTag(row.playerTag))
        .filter(Boolean),
    );
    const currentUnlinked = currentMembers.filter(
      (member) => !linkedTagSet.has(member.playerTag),
    );
    console.info(
      `[unlinked] stage=current_unlinked_summary guild=${guildId} current_member_count=${currentMembers.length} unresolved_count=${currentUnlinked.length}`,
    );
    const currentByTag = new Map(
      currentUnlinked.map((member) => [member.playerTag, member] as const),
    );
    const existingByTag = new Map(
      existingRows.map((row) => [normalizePlayerTag(row.playerTag), row] as const),
    );

    const resolvedTags = existingRows
      .map((row) => normalizePlayerTag(row.playerTag))
      .filter((playerTag) => playerTag && !currentByTag.has(playerTag));
    if (resolvedTags.length > 0) {
      await prisma.unlinkedPlayer.deleteMany({
        where: {
          guildId,
          playerTag: { in: resolvedTags },
        },
      });
    }

    let alertedCount = 0;
    for (const member of currentUnlinked) {
      const existing = existingByTag.get(member.playerTag) ?? null;
      await prisma.unlinkedPlayer.upsert({
        where: {
          guildId_playerTag: {
            guildId,
            playerTag: member.playerTag,
          },
        },
        create: {
          guildId,
          playerTag: member.playerTag,
          playerName: member.playerName,
          clanTag: member.clanTag,
          clanName: member.clanName,
          alertedAt: existing?.alertedAt ?? null,
        },
        update: {
          playerName: member.playerName,
          clanTag: member.clanTag,
          clanName: member.clanName,
        },
      });

      if (existing?.alertedAt) {
        continue;
      }

      const candidate = this.resolveAlertChannelCandidate({
        routingConfig,
        trackedClanLogChannelByTag,
        trackedClanLeaderChannelByTag: trackedClanAlertChannelsByTag.leaderChannelByTag,
        botLogChannelId,
        clanTag: member.clanTag,
      });
      if (!candidate) {
        continue;
      }

      if (!candidate.channelId) {
        console.info(
          `[unlinked] alert_destination_unusable guild=${guildId} player=${member.playerTag} clan=${member.clanTag} destination=none source=${candidate.source} reason=${candidate.source === "clan_lead" ? "missing_leader_channel" : "missing_channel"}`,
        );
        continue;
      }

      const channel = await resolveSendableGuildChannel({
        client: input.client,
        guildId,
        channelId: candidate.channelId,
      });
      if (!channel) {
        console.info(
          `[unlinked] alert_destination_unusable guild=${guildId} player=${member.playerTag} clan=${member.clanTag} destination=${candidate.channelId} source=${candidate.source} reason=unavailable_or_not_sendable`,
        );
        continue;
      }

      try {
        await channel.send({
          content: buildUnlinkedAlertContent({
            playerName: member.playerName,
            playerTag: member.playerTag,
            clanName: member.clanName,
          }),
          allowedMentions: { parse: [] },
        });
      } catch (err) {
        console.error(
          `[unlinked] alert_send_failed guild=${guildId} player=${member.playerTag} clan=${member.clanTag} destination=${candidate.channelId} source=${candidate.source} error=${formatError(err)}`,
        );
        continue;
      }

      alertedCount += 1;
      await prisma.unlinkedPlayer.update({
        where: {
          guildId_playerTag: {
            guildId,
            playerTag: member.playerTag,
          },
        },
        data: {
          alertedAt: new Date(),
        },
      });
    }

    try {
      await this.reconcileBannedPlayerJoinAlerts({
        client: input.client,
        guildId,
        routingConfig,
        trackedClanAlertChannelsByTag,
        botLogChannelId,
        currentMembers,
        linkedRows,
      });
    } catch (err) {
      console.error(
        `[banned] reconcile_failed guild=${guildId} error=${formatError(err)}`,
      );
    }

    return {
      unresolvedCount: currentUnlinked.length,
      alertedCount,
      resolvedCount: resolvedTags.length,
    };
  }

  /** Purpose: reconcile alerted banned joins without disturbing the unlinked pipeline. */
  private async reconcileBannedPlayerJoinAlerts(input: {
    client: DiscordClientLike;
    guildId: string;
    routingConfig: UnlinkedAlertRoutingConfig;
    trackedClanAlertChannelsByTag: {
      logChannelByTag: Map<string, string | null>;
      leaderChannelByTag: Map<string, string | null>;
    };
    botLogChannelId: string | null;
    currentMembers: CurrentUnlinkedTrackedMember[];
    linkedRows: Array<{ playerTag: string; discordUserId: string | null }>;
  }): Promise<void> {
    const now = new Date();
    if (input.currentMembers.length <= 0) {
      const existingRows = await bannedPlayerJoinAlertTable.bannedPlayerJoinAlert.findMany({
        where: { guildId: input.guildId },
        select: { playerTag: true, clanTag: true },
      });
      if (existingRows.length > 0) {
        await bannedPlayerJoinAlertTable.bannedPlayerJoinAlert.deleteMany({
          where: {
            guildId: input.guildId,
            OR: existingRows.map((row: { playerTag: string; clanTag: string }) => ({
              playerTag: row.playerTag,
              clanTag: row.clanTag,
            })),
          },
        });
        console.info(
          `[banned] banned_join_resolved guild=${input.guildId} resolved_count=${existingRows.length}`,
        );
      }
      console.info(
        `[banned] banned_join_current_summary guild=${input.guildId} current_member_count=0 active_banned_count=0 existing_alert_count=${existingRows.length}`,
      );
      return;
    }

    const linkedDiscordUserByPlayerTag = new Map<string, string>();
    for (const row of input.linkedRows) {
      const playerTag = normalizePlayerTag(row.playerTag);
      const discordUserId = normalizeDiscordUserId(row.discordUserId);
      if (!playerTag || !discordUserId) continue;
      linkedDiscordUserByPlayerTag.set(playerTag, discordUserId);
    }
    const linkedDiscordUserIds = [...new Set(linkedDiscordUserByPlayerTag.values())];
    const currentPlayerTags = input.currentMembers.map((member) => member.playerTag);

    const [directBanRows, userBanRows, existingRows] = await Promise.all([
      prisma.banRecord.findMany({
        where: {
          guildId: input.guildId,
          targetKind: BanTargetKind.PLAYER,
          playerTag: { in: currentPlayerTags },
          removedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
        orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
      }),
      linkedDiscordUserIds.length > 0
        ? prisma.banRecord.findMany({
            where: {
              guildId: input.guildId,
              targetKind: BanTargetKind.USER,
              discordUserId: { in: linkedDiscordUserIds },
              removedAt: null,
              OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
            },
            orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
          })
        : Promise.resolve([] as BanRecord[]),
      bannedPlayerJoinAlertTable.bannedPlayerJoinAlert.findMany({
        where: { guildId: input.guildId },
        orderBy: [{ createdAt: "asc" }, { playerTag: "asc" }, { clanTag: "asc" }],
      }),
    ]);

    const activePlayerBanByTag = new Map<string, BanRecord>();
    for (const row of directBanRows) {
      if (!row.playerTag) continue;
      const playerTag = normalizePlayerTag(row.playerTag);
      if (!playerTag) continue;
      if (!activePlayerBanByTag.has(playerTag)) {
        activePlayerBanByTag.set(playerTag, row);
      }
    }

    const activeUserBanByDiscordUserId = new Map<string, BanRecord>();
    for (const row of userBanRows) {
      const discordUserId = normalizeDiscordUserId(row.discordUserId);
      if (!discordUserId) continue;
      if (!activeUserBanByDiscordUserId.has(discordUserId)) {
        activeUserBanByDiscordUserId.set(discordUserId, row);
      }
    }

    const existingByKey = new Map(
      existingRows.map((row) => [buildBannedJoinAlertKey(row), row] as const),
    );

    const currentBannedMembers = input.currentMembers.flatMap((member) => {
      const directBan = activePlayerBanByTag.get(member.playerTag) ?? null;
      const linkedDiscordUserId = linkedDiscordUserByPlayerTag.get(member.playerTag) ?? null;
      const userBan =
        linkedDiscordUserId !== null
          ? activeUserBanByDiscordUserId.get(linkedDiscordUserId) ?? null
          : null;
      const activeBan = directBan ?? userBan;
      if (!activeBan) return [];
      return [
        {
          member,
          activeBan,
        },
      ];
    });

    console.info(
      `[banned] banned_join_current_summary guild=${input.guildId} current_member_count=${input.currentMembers.length} active_banned_count=${currentBannedMembers.length} existing_alert_count=${existingRows.length}`,
    );

    const activeKeySet = new Set<string>();
    let alertedCount = 0;
    for (const { member, activeBan } of currentBannedMembers) {
      const key = buildBannedJoinAlertKey({
        playerTag: member.playerTag,
        clanTag: member.clanTag,
      });
      activeKeySet.add(key);

      const existing = existingByKey.get(key) ?? null;
      await bannedPlayerJoinAlertTable.bannedPlayerJoinAlert.upsert({
        where: {
          guildId_playerTag_clanTag: {
            guildId: input.guildId,
            playerTag: member.playerTag,
            clanTag: member.clanTag,
          },
        },
        create: {
          guildId: input.guildId,
          playerTag: member.playerTag,
          clanTag: member.clanTag,
          playerName: member.playerName,
          clanName: member.clanName,
          banRecordId: activeBan.id,
          alertedAt: existing?.alertedAt ?? null,
        },
        update: {
          playerName: member.playerName,
          clanName: member.clanName,
          banRecordId: activeBan.id,
        },
      });

      if (existing?.alertedAt) {
        continue;
      }

      const candidate = this.resolveAlertChannelCandidate({
        routingConfig: input.routingConfig,
        trackedClanLogChannelByTag: input.trackedClanAlertChannelsByTag.logChannelByTag,
        trackedClanLeaderChannelByTag: input.trackedClanAlertChannelsByTag.leaderChannelByTag,
        botLogChannelId: input.botLogChannelId,
        clanTag: member.clanTag,
      });
      if (!candidate) {
        continue;
      }

      if (!candidate.channelId) {
        console.info(
          `[banned] banned_join_alert_destination_unusable guild=${input.guildId} player=${member.playerTag} clan=${member.clanTag} destination=none source=${candidate.source} reason=${candidate.source === "clan_lead" ? "missing_leader_channel" : "missing_channel"}`,
        );
        continue;
      }

      const channel = await resolveSendableGuildChannel({
        client: input.client,
        guildId: input.guildId,
        channelId: candidate.channelId,
      });
      if (!channel) {
        console.info(
          `[banned] banned_join_alert_destination_unusable guild=${input.guildId} player=${member.playerTag} clan=${member.clanTag} destination=${candidate.channelId} source=${candidate.source} reason=unavailable_or_not_sendable`,
        );
        continue;
      }

      try {
        await channel.send({
          content: buildBannedPlayerJoinAlertContent({
            playerName: member.playerName,
            playerTag: member.playerTag,
            clanName: member.clanName,
            ban: {
              targetKind: activeBan.targetKind,
              discordUserId: normalizeDiscordUserId(activeBan.discordUserId),
              reason: normalizeDisplayText(activeBan.reason, "No reason provided"),
              expiresAt: activeBan.expiresAt ?? null,
            },
          }),
          allowedMentions: { parse: [] },
        });
      } catch (err) {
        console.error(
          `[banned] banned_join_send_failed guild=${input.guildId} player=${member.playerTag} clan=${member.clanTag} destination=${candidate.channelId} source=${candidate.source} error=${formatError(err)}`,
        );
        continue;
      }

      alertedCount += 1;
      console.info(
        `[banned] banned_join_alert_sent guild=${input.guildId} player=${member.playerTag} clan=${member.clanTag} destination=${candidate.channelId} source=${candidate.source} ban_kind=${activeBan.targetKind.toLowerCase()}`,
      );
      await bannedPlayerJoinAlertTable.bannedPlayerJoinAlert.update({
        where: {
          guildId_playerTag_clanTag: {
            guildId: input.guildId,
            playerTag: member.playerTag,
            clanTag: member.clanTag,
          },
        },
        data: {
          alertedAt: new Date(),
        },
      });
    }

    const resolvedRows = existingRows.filter((row) => !activeKeySet.has(buildBannedJoinAlertKey(row)));
    if (resolvedRows.length > 0) {
      await bannedPlayerJoinAlertTable.bannedPlayerJoinAlert.deleteMany({
        where: {
          guildId: input.guildId,
          OR: resolvedRows.map((row: { playerTag: string; clanTag: string }) => ({
            playerTag: row.playerTag,
            clanTag: row.clanTag,
          })),
        },
      });
      console.info(
        `[banned] banned_join_resolved guild=${input.guildId} resolved_count=${resolvedRows.length}`,
      );
    }
  }

  /** Purpose: resolve one explicit unlinked-alert destination for the configured routing mode. */
  private resolveAlertChannelCandidate(input: {
    routingConfig: UnlinkedAlertRoutingConfig;
    trackedClanLogChannelByTag: Map<string, string | null>;
    trackedClanLeaderChannelByTag: Map<string, string | null>;
    botLogChannelId: string | null;
    clanTag: string;
  }): AlertChannelCandidate | null {
    const clanTag = normalizeClanTag(input.clanTag);
    if (input.routingConfig.routingMode === "CLAN_LOG") {
      const channelId = normalizeChannelId(
        input.trackedClanLogChannelByTag.get(clanTag) ?? null,
      );
      return { channelId, source: "clan_log" };
    }
    if (input.routingConfig.routingMode === "CLAN_LEAD") {
      const channelId = normalizeChannelId(
        input.trackedClanLeaderChannelByTag.get(clanTag) ?? null,
      );
      return { channelId, source: "clan_lead" };
    }
    if (input.routingConfig.routingMode === "BOT_LOG") {
      const channelId = normalizeChannelId(input.botLogChannelId);
      return { channelId, source: "bot_log" };
    }
    if (input.routingConfig.routingMode === "CUSTOM") {
      const channelId = normalizeChannelId(input.routingConfig.channelId);
      return { channelId, source: "custom" };
    }
    return null;
  }
}

export const unlinkedMemberAlertService = new UnlinkedMemberAlertService();
