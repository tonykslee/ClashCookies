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

function normalizeGuildId(input: string): string {
  return String(input ?? "").trim();
}

function normalizeChannelId(input: string | null | undefined): string | null {
  const trimmed = String(input ?? "").trim();
  return /^\d+$/.test(trimmed) ? trimmed : null;
}

function normalizeDisplayText(input: string | null | undefined, fallback: string): string {
  const normalized = String(input ?? "").replace(/\s+/g, " ").trim();
  return normalized || fallback;
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

async function loadTrackedClanLogChannelByTag(): Promise<Map<string, string | null>> {
  const trackedClans = await runBoundedUnlinkedStage({
    stage: "tracked_clan_log_channel_query",
    timeoutMs: UNLINKED_DB_STAGE_TIMEOUT_MS,
    action: () =>
      prisma.trackedClan.findMany({
        orderBy: [{ createdAt: "asc" }, { tag: "asc" }],
        select: {
          tag: true,
          logChannelId: true,
        },
      }),
  });
  return new Map(
    trackedClans.map((row) => [
      normalizeClanTag(row.tag),
      normalizeChannelId(row.logChannelId),
    ] as const),
  );
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
  /** Purpose: persist one guild-level unlinked alert channel in the feature-owned table. */
  async setAlertChannelId(input: { guildId: string; channelId: string }): Promise<void> {
    const guildId = normalizeGuildId(input.guildId);
    const channelId = normalizeChannelId(input.channelId);
    if (!guildId || !channelId) {
      throw new Error("INVALID_UNLINKED_ALERT_CHANNEL");
    }

    await prisma.unlinkedAlertConfig.upsert({
      where: { guildId },
      create: {
        guildId,
        channelId,
      },
      update: {
        channelId,
      },
    });
  }

  /** Purpose: return the configured guild-level unlinked alert channel when valid. */
  async getAlertChannelId(guildId: string): Promise<string | null> {
    const normalizedGuildId = normalizeGuildId(guildId);
    if (!normalizedGuildId) return null;

    const row = await prisma.unlinkedAlertConfig.findUnique({
      where: { guildId: normalizedGuildId },
      select: { channelId: true },
    });
    return normalizeChannelId(row?.channelId);
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

    const [fwaMembers, cwlMembers] = await Promise.all([
      loadLiveFwaMembers({
        cocService: input.cocService,
        observedFwaClans: input.observedFwaClans,
      }),
      loadLiveCwlMembers({
        cocService: input.cocService,
      }),
    ]);

    const currentMembers = dedupeTrackedMembers(
      [...fwaMembers, ...cwlMembers],
      input.clanTag ?? null,
    );
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

    const trackedClanLogChannelByTag = await loadTrackedClanLogChannelByTag();
    const [fwaMembers, cwlMembers, configuredAlertChannelId, existingRows] =
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
        this.getAlertChannelId(guildId),
        prisma.unlinkedPlayer.findMany({
          where: { guildId },
          orderBy: [{ createdAt: "asc" }, { playerTag: "asc" }],
        }),
      ]);

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

      const fallbackChannelId = trackedClanLogChannelByTag.get(member.clanTag) ?? null;
      const channelId = await this.resolveAlertChannelId({
        client: input.client,
        guildId,
        configuredAlertChannelId,
        fallbackChannelId,
      });
      if (!channelId) {
        continue;
      }

      const channel = await resolveSendableGuildChannel({
        client: input.client,
        guildId,
        channelId,
      });
      if (!channel) {
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
      } catch (err) {
        console.error(
          `[unlinked] alert_send_failed guild=${guildId} player=${member.playerTag} clan=${member.clanTag} error=${formatError(err)}`,
        );
      }
    }

    return {
      unresolvedCount: currentUnlinked.length,
      alertedCount,
      resolvedCount: resolvedTags.length,
    };
  }

  /** Purpose: prefer configured guild-level alert routing and fall back to tracked-clan log routing when needed. */
  private async resolveAlertChannelId(input: {
    client: DiscordClientLike;
    guildId: string;
    configuredAlertChannelId: string | null;
    fallbackChannelId: string | null;
  }): Promise<string | null> {
    const configured = normalizeChannelId(input.configuredAlertChannelId);
    if (configured) {
      const configuredChannel = await resolveSendableGuildChannel({
        client: input.client,
        guildId: input.guildId,
        channelId: configured,
      });
      if (configuredChannel) {
        return configured;
      }
    }

    const fallback = normalizeChannelId(input.fallbackChannelId);
    if (!fallback) {
      return null;
    }
    const fallbackChannel = await resolveSendableGuildChannel({
      client: input.client,
      guildId: input.guildId,
      channelId: fallback,
    });
    return fallbackChannel ? fallback : null;
  }
}

export const unlinkedMemberAlertService = new UnlinkedMemberAlertService();
