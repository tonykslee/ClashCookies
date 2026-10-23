import { prisma } from "../prisma";
import { normalizeClanTag, normalizeDiscordUserId, normalizePlayerTag } from "./PlayerLinkService";
import { resolveCurrentCwlSeasonKey } from "./CwlRegistryService";
import { normalizeRaidTrackedClanTag } from "./RaidTrackedClanService";
import { getConfiguredClanMembersCadenceMinutes, getHomeRosterCoverage } from "./HomeRosterService";
import { CoCService } from "./CoCService";
import { runWithCoCQueueContext } from "./CoCQueueContext";
import { FwaClanMembersSyncService } from "./fwa-feeds/FwaClanMembersSyncService";
import { isActivePollingMode } from "./PollingModeService";

export type TrackedClanLeadersRegistry = "FWA" | "CWL" | "RAIDS";
export type TrackedClanLeadersFreshness = "CURRENT" | "STALE" | "UNAVAILABLE" | "REFRESH_FAILED";
export type TrackedClanLeaderRole = "leader" | "coLeader";

export type TrackedClanLeaderAccount = {
  playerTag: string;
  playerName: string;
  role: TrackedClanLeaderRole;
  discordUserId: string | null;
};

export type TrackedClanLeaderGroup = {
  discordUserId: string | null;
  accounts: TrackedClanLeaderAccount[];
  hasLeader: boolean;
};

export type TrackedClanLeadersClan = {
  registry: TrackedClanLeadersRegistry;
  clanTag: string;
  name: string | null;
  clanBadge: string | null;
  registryIcon: string;
  leagueLabel: string | null;
  freshness: TrackedClanLeadersFreshness;
  observedAt: Date | null;
  lastError: string | null;
  leaderGroups: TrackedClanLeaderGroup[];
};

export type TrackedClanLeadersSection = {
  registry: TrackedClanLeadersRegistry;
  clans: TrackedClanLeadersClan[];
};

export type TrackedClanLeadersView = {
  season: string;
  sections: TrackedClanLeadersSection[];
  displayedClanTags: string[];
  totalClanCount: number;
};

export type RefreshTrackedClanLeadersResult = {
  view: TrackedClanLeadersView;
  refreshedClanTags: string[];
  failedClanTags: string[];
  blockedReason: "MIRROR_MODE_DISABLED" | null;
};

type RegistryRow = {
  registry: TrackedClanLeadersRegistry;
  clanTag: string;
  name: string | null;
  leagueLabel: string | null;
  createdAt: Date;
  clanBadge: string | null;
};

type MemberRow = {
  clanTag: string;
  playerTag: string;
  playerName: string;
  role: string | null;
  sourceSyncedAt: Date;
};

const REGISTRY_ORDER: TrackedClanLeadersRegistry[] = ["FWA", "CWL", "RAIDS"];
const REGISTRY_ICON: Record<TrackedClanLeadersRegistry, string> = {
  FWA: "🛡️",
  CWL: "⚔️",
  RAIDS: "🏰",
};

function normalizeText(input: unknown): string | null {
  const value = String(input ?? "").replace(/\s+/g, " ").trim();
  return value.length > 0 ? value : null;
}

function validDate(input: unknown): Date | null {
  if (input instanceof Date && Number.isFinite(input.getTime())) return input;
  const parsed = new Date(String(input ?? ""));
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

/** Purpose: preserve the existing clan-role normalization semantics for persisted roster values. */
export function normalizeTrackedClanLeaderRole(input: unknown): TrackedClanLeaderRole | null {
  const normalized = String(input ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z]/g, "");
  if (normalized === "leader") return "leader";
  if (normalized === "coleader") return "coLeader";
  return null;
}

function normalizeRegistryFilter(input: TrackedClanLeadersRegistry | null | undefined): TrackedClanLeadersRegistry[] {
  return input ? [input] : REGISTRY_ORDER;
}

function normalizeTagSet(tags: string[]): Set<string> {
  return new Set(tags.map((tag) => normalizeClanTag(tag)).filter(Boolean));
}

function normalizeRefreshTagSet(tags: string[] | undefined): Set<string> {
  return normalizeTagSet(tags ?? []);
}

function chooseObservedAt(rows: MemberRow[], feedState: any | null): Date | null {
  const memberObservedAt = rows
    .map((row) => validDate(row.sourceSyncedAt))
    .filter((value): value is Date => value !== null)
    .sort((left, right) => right.getTime() - left.getTime())[0] ?? null;
  const feedObservedAt = validDate(feedState?.lastSuccessAt);
  if (!memberObservedAt) return feedObservedAt;
  if (!feedObservedAt) return memberObservedAt;
  return memberObservedAt.getTime() >= feedObservedAt.getTime() ? memberObservedAt : feedObservedAt;
}

function resolveFreshness(input: {
  observedAt: Date | null;
  feedState: any | null;
  memberRowCount: number;
  now: Date;
  refreshSucceeded: boolean;
  refreshFailed: boolean;
}): { freshness: TrackedClanLeadersFreshness; observedAt: Date | null; lastError: string | null } {
  const persistedFeedRowCount = Number.isInteger(input.feedState?.lastRowCount)
    ? Number(input.feedState.lastRowCount)
    : null;
  const hasCompleteRosterCoverage = persistedFeedRowCount === null
    ? input.memberRowCount > 0
    : input.memberRowCount === persistedFeedRowCount;

  if (input.refreshFailed) {
    return {
      freshness: "REFRESH_FAILED",
      observedAt: input.observedAt,
      lastError: normalizeText(input.feedState?.lastErrorSummary),
    };
  }

  if (!hasCompleteRosterCoverage) {
    return {
      freshness: input.memberRowCount === 0 ? "UNAVAILABLE" : "STALE",
      observedAt: input.observedAt,
      lastError: normalizeText(input.feedState?.lastErrorSummary),
    };
  }

  if (input.refreshSucceeded) {
    return { freshness: "CURRENT", observedAt: input.now, lastError: null };
  }

  if (!input.observedAt) {
    return {
      freshness: "UNAVAILABLE",
      observedAt: null,
      lastError: normalizeText(input.feedState?.lastErrorSummary),
    };
  }

  const lastAttemptAt = validDate(input.feedState?.lastAttemptAt);
  const feedFailedAfterObservation =
    String(input.feedState?.lastStatus ?? "").toUpperCase() === "FAILURE" &&
    Boolean(lastAttemptAt && lastAttemptAt.getTime() > input.observedAt.getTime());
  const coverage = getHomeRosterCoverage({
    lastSuccessAt: input.observedAt,
    now: input.now,
    cadenceMinutes: getConfiguredClanMembersCadenceMinutes(),
  }).coverage;
  return {
    freshness: feedFailedAfterObservation || coverage === "STALE" ? "STALE" : "CURRENT",
    observedAt: input.observedAt,
    lastError: normalizeText(input.feedState?.lastErrorSummary),
  };
}

function buildLeaderGroups(input: {
  clanTag: string;
  memberRowsByClan: Map<string, MemberRow[]>;
  playerLinkByTag: Map<string, string | null>;
}): TrackedClanLeaderGroup[] {
  const linkedGroups = new Map<string, TrackedClanLeaderGroup>();
  const unlinkedGroups: TrackedClanLeaderGroup[] = [];
  const rows = input.memberRowsByClan.get(input.clanTag) ?? [];

  for (const row of rows) {
    const role = normalizeTrackedClanLeaderRole(row.role);
    const playerTag = normalizePlayerTag(row.playerTag);
    if (!role || !playerTag) continue;
    const account: TrackedClanLeaderAccount = {
      playerTag,
      playerName: normalizeText(row.playerName) ?? playerTag,
      role,
      discordUserId: input.playerLinkByTag.get(playerTag) ?? null,
    };

    if (account.discordUserId) {
      const existing = linkedGroups.get(account.discordUserId) ?? {
        discordUserId: account.discordUserId,
        accounts: [],
        hasLeader: false,
      };
      existing.accounts.push(account);
      existing.hasLeader ||= account.role === "leader";
      linkedGroups.set(account.discordUserId, existing);
    } else {
      unlinkedGroups.push({
        discordUserId: null,
        accounts: [account],
        hasLeader: account.role === "leader",
      });
    }
  }

  const sortAccounts = (left: TrackedClanLeaderAccount, right: TrackedClanLeaderAccount): number => {
    const roleOrder = left.role === right.role ? 0 : left.role === "leader" ? -1 : 1;
    return roleOrder || left.playerName.localeCompare(right.playerName) || left.playerTag.localeCompare(right.playerTag);
  };
  const sortGroups = (left: TrackedClanLeaderGroup, right: TrackedClanLeaderGroup): number => {
    const roleOrder = left.hasLeader === right.hasLeader ? 0 : left.hasLeader ? -1 : 1;
    const leftName = left.accounts[0]?.playerName ?? "";
    const rightName = right.accounts[0]?.playerName ?? "";
    return roleOrder || leftName.localeCompare(rightName) || (left.discordUserId ?? "").localeCompare(right.discordUserId ?? "");
  };

  const groups = [...linkedGroups.values(), ...unlinkedGroups];
  for (const group of groups) group.accounts.sort(sortAccounts);
  return groups.sort(sortGroups);
}

async function loadRegistryRows(input: {
  registryFilter?: TrackedClanLeadersRegistry | null;
  season: string;
}): Promise<RegistryRow[]> {
  const selected = new Set(normalizeRegistryFilter(input.registryFilter));
  const [fwaRows, cwlRows, raidRows] = await Promise.all([
    selected.has("FWA")
      ? prisma.trackedClan.findMany({
          orderBy: [{ createdAt: "asc" }, { tag: "asc" }],
          select: { tag: true, name: true, clanBadge: true, createdAt: true },
        })
      : Promise.resolve([]),
    selected.has("CWL")
      ? prisma.cwlTrackedClan.findMany({
          where: { season: input.season },
          orderBy: [{ createdAt: "asc" }, { tag: "asc" }],
          select: { tag: true, name: true, leagueLabel: true, createdAt: true },
        })
      : Promise.resolve([]),
    selected.has("RAIDS")
      ? prisma.raidTrackedClan.findMany({
          orderBy: [{ createdAt: "asc" }, { clanTag: "asc" }],
          select: { clanTag: true, name: true, createdAt: true },
        })
      : Promise.resolve([]),
  ]);

  const rows: RegistryRow[] = [];
  const seenByRegistry = new Set<string>();
  const add = (row: RegistryRow) => {
    const key = `${row.registry}:${row.clanTag}`;
    if (!row.clanTag || seenByRegistry.has(key)) return;
    seenByRegistry.add(key);
    rows.push(row);
  };

  for (const row of fwaRows as Array<{ tag: string; name: string | null; clanBadge: string | null; createdAt: Date }>) {
    const clanTag = normalizeClanTag(row.tag);
    if (clanTag) add({ registry: "FWA", clanTag, name: normalizeText(row.name), clanBadge: normalizeText(row.clanBadge), leagueLabel: null, createdAt: row.createdAt });
  }
  for (const row of cwlRows as Array<{ tag: string; name: string | null; leagueLabel: string | null; createdAt: Date }>) {
    const clanTag = normalizeClanTag(row.tag);
    if (clanTag) add({ registry: "CWL", clanTag, name: normalizeText(row.name), clanBadge: null, leagueLabel: normalizeText(row.leagueLabel), createdAt: row.createdAt });
  }
  for (const row of raidRows as Array<{ clanTag: string; name: string | null; createdAt: Date }>) {
    const clanTag = normalizeClanTag(normalizeRaidTrackedClanTag(row.clanTag) ?? row.clanTag);
    if (clanTag) add({ registry: "RAIDS", clanTag, name: normalizeText(row.name), clanBadge: null, leagueLabel: null, createdAt: row.createdAt });
  }

  return rows.sort((left, right) => {
    const registryOrder = REGISTRY_ORDER.indexOf(left.registry) - REGISTRY_ORDER.indexOf(right.registry);
    return registryOrder || left.createdAt.getTime() - right.createdAt.getTime() || left.clanTag.localeCompare(right.clanTag);
  });
}

/** Purpose: load the DB-first leadership view across one registry or all current registries. */
export async function loadTrackedClanLeadersView(input?: {
  registry?: TrackedClanLeadersRegistry | null;
  season?: string;
  now?: Date;
  refreshSucceededTags?: string[];
  refreshFailedTags?: string[];
}): Promise<TrackedClanLeadersView> {
  const season = input?.season ?? resolveCurrentCwlSeasonKey();
  const now = input?.now instanceof Date && Number.isFinite(input.now.getTime()) ? input.now : new Date();
  const registryRows = await loadRegistryRows({ registryFilter: input?.registry ?? null, season });
  const displayedClanTags = [...new Set(registryRows.map((row) => row.clanTag))];
  if (displayedClanTags.length === 0) {
    return { season, sections: [], displayedClanTags: [], totalClanCount: 0 };
  }

  const [trackedRows, memberRows, feedStates] = await Promise.all([
    prisma.trackedClan.findMany({
      where: { tag: { in: displayedClanTags } },
      select: { tag: true, name: true, clanBadge: true },
    }),
    prisma.fwaClanMemberCurrent.findMany({
      where: { clanTag: { in: displayedClanTags } },
      orderBy: [{ clanTag: "asc" }, { playerTag: "asc" }],
      select: { clanTag: true, playerTag: true, playerName: true, role: true, sourceSyncedAt: true },
    }),
    prisma.fwaFeedSyncState.findMany({
      where: {
        feedType: "CLAN_MEMBERS",
        scopeType: "CLAN_TAG",
        scopeKey: { in: displayedClanTags },
      },
      select: {
        scopeKey: true,
        lastAttemptAt: true,
        lastSuccessAt: true,
        lastStatus: true,
        lastErrorSummary: true,
        lastRowCount: true,
      },
    }),
  ]);

  const normalizedMemberRows = (memberRows as MemberRow[]).map((row) => ({
    ...row,
    clanTag: normalizeClanTag(row.clanTag),
    playerTag: normalizePlayerTag(row.playerTag),
  })).filter((row) => row.clanTag && row.playerTag);
  const memberRowsByClan = new Map<string, MemberRow[]>();
  for (const row of normalizedMemberRows) {
    const rows = memberRowsByClan.get(row.clanTag) ?? [];
    rows.push(row);
    memberRowsByClan.set(row.clanTag, rows);
  }
  const playerTags = [...new Set(normalizedMemberRows.map((row) => row.playerTag))];
  const playerLinks = playerTags.length > 0
    ? await prisma.playerLink.findMany({
        where: { playerTag: { in: playerTags } },
        select: { playerTag: true, discordUserId: true },
      })
    : [];
  const playerLinkByTag = new Map<string, string | null>();
  for (const row of playerLinks as Array<{ playerTag: string; discordUserId: string | null }>) {
    const playerTag = normalizePlayerTag(row.playerTag);
    if (!playerTag) continue;
    playerLinkByTag.set(playerTag, normalizeDiscordUserId(row.discordUserId));
  }

  const trackedByTag = new Map<string, { name: string | null; clanBadge: string | null }>();
  for (const row of trackedRows as Array<{ tag: string; name: string | null; clanBadge: string | null }>) {
    const clanTag = normalizeClanTag(row.tag);
    if (clanTag) trackedByTag.set(clanTag, { name: normalizeText(row.name), clanBadge: normalizeText(row.clanBadge) });
  }
  const feedStateByTag = new Map<string, any>();
  for (const row of feedStates as Array<{
    scopeKey: string;
    lastAttemptAt: Date | null;
    lastSuccessAt: Date | null;
    lastStatus: string;
    lastErrorSummary: string | null;
    lastRowCount: number | null;
  }>) {
    const clanTag = normalizeClanTag(row.scopeKey);
    if (clanTag) feedStateByTag.set(clanTag, row);
  }
  const refreshSucceeded = normalizeRefreshTagSet(input?.refreshSucceededTags);
  const refreshFailed = normalizeRefreshTagSet(input?.refreshFailedTags);
  const sections = new Map<TrackedClanLeadersRegistry, TrackedClanLeadersClan[]>();

  for (const row of registryRows) {
    const tracked = trackedByTag.get(row.clanTag);
    const clanRows = memberRowsByClan.get(row.clanTag) ?? [];
    const feedState = feedStateByTag.get(row.clanTag) ?? null;
    const observedAt = chooseObservedAt(clanRows, feedState);
    const freshness = resolveFreshness({
      observedAt,
      feedState,
      memberRowCount: clanRows.length,
      now,
      refreshSucceeded: refreshSucceeded.has(row.clanTag),
      refreshFailed: refreshFailed.has(row.clanTag),
    });
    const clan: TrackedClanLeadersClan = {
      registry: row.registry,
      clanTag: row.clanTag,
      name: row.name ?? tracked?.name ?? null,
      clanBadge: row.clanBadge ?? tracked?.clanBadge ?? null,
      registryIcon: REGISTRY_ICON[row.registry],
      leagueLabel: row.leagueLabel,
      freshness: freshness.freshness,
      observedAt: freshness.observedAt,
      lastError: freshness.lastError,
      leaderGroups: buildLeaderGroups({ clanTag: row.clanTag, memberRowsByClan, playerLinkByTag }),
    };
    const section = sections.get(row.registry) ?? [];
    section.push(clan);
    sections.set(row.registry, section);
  }

  return {
    season,
    sections: REGISTRY_ORDER.filter((registry) => sections.has(registry)).map((registry) => ({
      registry,
      clans: sections.get(registry) ?? [],
    })),
    displayedClanTags,
    totalClanCount: registryRows.length,
  };
}

/** Purpose: refresh unique displayed clan rosters through the interactive CoC queue and reload persisted leadership data. */
export async function refreshTrackedClanLeadersWithQueueContext(input: {
  cocService: CoCService;
  registry?: TrackedClanLeadersRegistry | null;
  season?: string;
  now?: Date;
}): Promise<RefreshTrackedClanLeadersResult> {
  const initialView = await loadTrackedClanLeadersView({ registry: input.registry ?? null, season: input.season, now: input.now });
  const clanTags = [...new Set(initialView.displayedClanTags)];
  if (clanTags.length === 0) {
    return { view: initialView, refreshedClanTags: [], failedClanTags: [], blockedReason: null };
  }
  if (!isActivePollingMode()) {
    console.warn(`[tracked-clan] event=leaders_refresh status=SKIPPED reason=mirror_mode displayed_count=${clanTags.length}`);
    return {
      view: initialView,
      refreshedClanTags: [],
      failedClanTags: [],
      blockedReason: "MIRROR_MODE_DISABLED",
    };
  }

  console.info(`[tracked-clan] event=leaders_refresh status=STARTED displayed_count=${clanTags.length}`);
  const service = new FwaClanMembersSyncService();
  let refreshedClanTags: string[] = [];
  let failedClanTags: string[] = [];
  try {
    const result = await runWithCoCQueueContext(
      { priority: "interactive", source: "tracked-clan:list:leaders:refresh" },
      () => service.refreshCurrentClanMembersForClanTags(clanTags, { cocService: input.cocService, concurrency: 4 }),
    );
    const failed = normalizeTagSet(result.failedClans);
    failedClanTags = clanTags.filter((tag) => failed.has(tag));
    refreshedClanTags = clanTags.filter((tag) => !failed.has(tag));
  } catch (error) {
    failedClanTags = clanTags;
    console.error(`[tracked-clan] event=leaders_refresh status=FAILURE displayed_count=${clanTags.length} error=${String(error).slice(0, 200)}`);
  }

  const view = await loadTrackedClanLeadersView({
    registry: input.registry ?? null,
    season: input.season,
    now: input.now,
    refreshSucceededTags: refreshedClanTags,
    refreshFailedTags: failedClanTags,
  });
  const refreshStatus = failedClanTags.length === 0
    ? "SUCCESS"
    : refreshedClanTags.length === 0
      ? "FAILURE"
      : "PARTIAL";
  console.info(`[tracked-clan] event=leaders_refresh status=${refreshStatus} displayed_count=${clanTags.length} failed_count=${failedClanTags.length}`);
  return { view, refreshedClanTags, failedClanTags, blockedReason: null };
}
