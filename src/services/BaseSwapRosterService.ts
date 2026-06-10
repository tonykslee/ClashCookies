import { prisma } from "../prisma";
import { CoCService } from "./CoCService";
import { cwlStateService } from "./CwlStateService";
import { resolveCurrentCwlSeasonKey } from "./CwlRegistryService";
import { listCwlTrackedClansForSeason } from "./CwlRegistryService";
import { listFwaTrackedClansForDisplay } from "./TrackedClanListService";
import {
  normalizeClanTag,
  normalizePersistedPlayerName,
} from "./PlayerLinkService";
import { listPlayerLinksForClanMembers } from "./PlayerLinkService";

export type BaseSwapClanKind = "FWA" | "CWL";

export type BaseSwapRosterMember = {
  position: number;
  playerTag: string;
  playerName: string;
  townhallLevel: number | null;
  discordUserId: string | null;
};

export type BaseSwapPhaseTiming = {
  warState: string;
  prepEndMs: number | null;
  warEndMs: number | null;
};

export type BaseSwapRosterResolution = {
  clanKind: BaseSwapClanKind;
  clanTag: string;
  clanName: string;
  rosterMembers: BaseSwapRosterMember[];
  phaseTiming: BaseSwapPhaseTiming | null;
  currentWarIdentity: {
    state: string | null;
    prepStartTime: Date | null;
    startTime: Date | null;
    endTime: Date | null;
  } | null;
};

export type BaseSwapRosterResolutionResult =
  | {
      ok: true;
      roster: BaseSwapRosterResolution;
    }
  | {
      ok: false;
      error: string;
    };

export type BaseSwapClanAutocompleteChoice = {
  name: string;
  value: string;
};

type ParsedBaseSwapClanReference = {
  clanKind?: BaseSwapClanKind;
  clanTag: string;
};

type FwaBaseSwapResolution = {
  clanKind: "FWA";
  clanTag: string;
  clanName: string;
  rosterMembers: BaseSwapRosterMember[];
  phaseTiming: BaseSwapPhaseTiming | null;
};

type CwlBaseSwapResolution = {
  clanKind: "CWL";
  clanTag: string;
  clanName: string;
  rosterMembers: BaseSwapRosterMember[];
  phaseTiming: BaseSwapPhaseTiming | null;
};

function normalizeDisplayName(input: string | null | undefined): string | null {
  return normalizePersistedPlayerName(input);
}

function formatClanTagForDisplay(input: string): string {
  const normalized = normalizeClanTag(input);
  return normalized || String(input ?? "").trim();
}

function normalizeBaseSwapClanReference(input: string): ParsedBaseSwapClanReference | null {
  const trimmed = String(input ?? "").trim();
  if (!trimmed) return null;

  const explicitMatch = trimmed.match(/^(fwa|cwl)\s*:\s*(.+)$/i);
  if (explicitMatch) {
    const clanKind = String(explicitMatch[1] ?? "").trim().toUpperCase();
    const clanTag = normalizeClanTag(String(explicitMatch[2] ?? "")).replace(/^#/, "");
    if (!clanTag || (clanKind !== "FWA" && clanKind !== "CWL")) {
      return null;
    }
    return {
      clanKind: clanKind as BaseSwapClanKind,
      clanTag,
    };
  }

  const clanTag = normalizeClanTag(trimmed).replace(/^#/, "");
  if (!clanTag) return null;
  return { clanTag };
}

function buildBaseSwapAutocompleteLabel(input: {
  clanKind: BaseSwapClanKind;
  clanTag: string;
  clanName: string | null;
  season: string;
  isAmbiguous: boolean;
}): string {
  const clanName = normalizeDisplayName(input.clanName);
  const baseLabel = clanName ? `${clanName} (${input.clanTag})` : input.clanTag;
  if (input.clanKind === "CWL") {
    return `${baseLabel} [CWL ${input.season}]`.slice(0, 100);
  }
  if (input.isAmbiguous) {
    return `${baseLabel} [FWA]`.slice(0, 100);
  }
  return baseLabel.slice(0, 100);
}

function buildBaseSwapAutocompleteValue(input: {
  clanKind: BaseSwapClanKind;
  clanTag: string;
}): string {
  return `${input.clanKind.toLowerCase()}:${input.clanTag}`;
}

function toPositiveIntegerOrNull(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const parsed = Math.trunc(value);
  return parsed > 0 ? parsed : null;
}

function buildPhaseTimingLineSource(input: {
  roundState: string | null;
  startTime: Date | null;
  endTime: Date | null;
}): BaseSwapPhaseTiming | null {
  const state = String(input.roundState ?? "").trim();
  if (!state) return null;
  return {
    warState: state,
    prepEndMs: input.startTime?.getTime() ?? null,
    warEndMs: input.endTime?.getTime() ?? null,
  };
}

function mapFwaCurrentWarRosterMember(input: {
  member: {
    mapPosition?: number | null;
    tag?: string | null;
    name?: string | null;
    townhallLevel?: number | null;
    townHallLevel?: number | null;
  };
}): BaseSwapRosterMember | null {
  const position =
    typeof input.member.mapPosition === "number" &&
    Number.isFinite(input.member.mapPosition)
      ? Math.trunc(input.member.mapPosition)
      : null;
  const playerTag = normalizeClanTag(String(input.member.tag ?? ""));
  if (!position || position <= 0 || !playerTag) return null;
  const playerName = normalizeDisplayName(input.member.name) ?? "Unknown";
  const rawTownhall = input.member.townhallLevel ?? input.member.townHallLevel;
  return {
    position,
    playerTag,
    playerName,
    townhallLevel: toPositiveIntegerOrNull(rawTownhall),
    discordUserId: null,
  };
}

function isBaseSwapRosterMember(
  member: BaseSwapRosterMember | null,
): member is BaseSwapRosterMember {
  return member !== null;
}

async function loadFwaBaseSwapRoster(input: {
  clanTag: string;
  guildId: string;
  cocService: CoCService;
}): Promise<BaseSwapRosterResolutionResult> {
  const trackedClan = await prisma.trackedClan.findFirst({
    where: {
      OR: [
        { tag: { equals: `#${input.clanTag}`, mode: "insensitive" } },
        { tag: { equals: input.clanTag, mode: "insensitive" } },
      ],
    },
    select: { tag: true, name: true },
  });
  if (!trackedClan) {
    return {
      ok: false,
      error: `Clan ${formatClanTagForDisplay(input.clanTag)} is not in tracked FWA clans.`,
    };
  }

  const currentWarRow = await prisma.currentWar.findFirst({
    where: {
      guildId: input.guildId,
      OR: [{ clanTag: `#${input.clanTag}` }, { clanTag: input.clanTag }],
    },
    orderBy: [{ updatedAt: "desc" }],
    select: {
      state: true,
      prepStartTime: true,
      startTime: true,
      endTime: true,
    },
  });

  const war = await input.cocService.getCurrentWar(input.clanTag).catch(() => null);
  if (
    !war ||
    !war.clan ||
    !Array.isArray(war.clan.members) ||
    war.clan.members.length === 0
  ) {
    return {
      ok: false,
      error: `No active current war roster found for ${formatClanTagForDisplay(input.clanTag)}.`,
    };
  }

  const roster = war.clan.members
    .map((member) => mapFwaCurrentWarRosterMember({ member }))
    .filter(isBaseSwapRosterMember)
    .sort((a, b) => a.position - b.position);

  const links = await listPlayerLinksForClanMembers({
    memberTagsInOrder: roster.map((member) => member.playerTag),
  });
  const linkByTag = new Map(
    links.map((link) => [normalizeClanTag(link.playerTag), link]),
  );
  const rosterMembers = roster.map((member) => ({
    ...member,
    discordUserId: linkByTag.get(member.playerTag)?.discordUserId ?? null,
  }));

  return {
    ok: true,
    roster: {
      clanKind: "FWA",
      clanTag: input.clanTag,
      clanName: normalizeDisplayName(trackedClan.name) ?? `#${input.clanTag}`,
      rosterMembers,
      currentWarIdentity: currentWarRow
        ? {
            state: String(currentWarRow.state ?? "").trim() || null,
            prepStartTime: currentWarRow.prepStartTime ?? null,
            startTime: currentWarRow.startTime ?? null,
            endTime: currentWarRow.endTime ?? null,
          }
        : null,
      phaseTiming: currentWarRow
        ? buildPhaseTimingLineSource({
            roundState: String(currentWarRow.state ?? "").trim(),
            startTime: currentWarRow.startTime ?? null,
            endTime: currentWarRow.endTime ?? null,
          })
        : null,
    },
  };
}

async function loadCwlBaseSwapRoster(input: {
  clanTag: string;
  season: string;
}): Promise<BaseSwapRosterResolutionResult> {
  const trackedClan = await prisma.cwlTrackedClan.findFirst({
    where: {
      season: input.season,
      tag: { equals: `#${input.clanTag}`, mode: "insensitive" },
    },
    select: { tag: true, name: true },
  });
  if (!trackedClan) {
    return {
      ok: false,
      error: `Clan ${formatClanTagForDisplay(input.clanTag)} is not in current-season tracked CWL clans.`,
    };
  }

  const [currentRound, currentPreparation] = await Promise.all([
    cwlStateService.getCurrentRoundForClan({
      clanTag: input.clanTag,
      season: input.season,
    }),
    cwlStateService.getCurrentPreparationSnapshotForClan({
      clanTag: input.clanTag,
      season: input.season,
    }),
  ]);

  const activeLineup =
    currentRound?.members?.length && currentRound.members.length > 0
      ? {
          clanName: currentRound.clanName,
          roundState: currentRound.roundState,
          startTime: currentRound.startTime,
          endTime: currentRound.endTime,
          members: currentRound.members,
        }
      : currentPreparation?.members?.length && currentPreparation.members.length > 0
        ? {
            clanName: currentPreparation.clanName,
            roundState: currentPreparation.roundState,
            startTime: currentPreparation.startTime,
            endTime: currentPreparation.endTime,
            members: currentPreparation.members,
          }
        : null;

  if (!activeLineup) {
    return {
      ok: false,
      error: "No active CWL lineup found for this tracked CWL clan.",
    };
  }

  const rosterMembers = activeLineup.members
    .map<BaseSwapRosterMember | null>((member, index) => {
      const playerTag = normalizeClanTag(member.playerTag);
      if (!playerTag) return null;
      return {
        position: index + 1,
        playerTag,
        playerName: normalizeDisplayName(member.playerName) ?? "Unknown",
        townhallLevel: toPositiveIntegerOrNull(member.townHall),
        discordUserId: null,
      };
    })
    .filter(isBaseSwapRosterMember);

  const links = await listPlayerLinksForClanMembers({
    memberTagsInOrder: rosterMembers.map((member) => member.playerTag),
  });
  const linkByTag = new Map(
    links.map((link) => [normalizeClanTag(link.playerTag), link]),
  );
  const linkedRosterMembers = rosterMembers.map((member) => ({
    ...member,
    discordUserId: linkByTag.get(member.playerTag)?.discordUserId ?? null,
  }));

  return {
    ok: true,
    roster: {
      clanKind: "CWL",
      clanTag: input.clanTag,
      clanName:
        normalizeDisplayName(activeLineup.clanName) ??
        normalizeDisplayName(trackedClan.name) ??
        formatClanTagForDisplay(input.clanTag),
      rosterMembers: linkedRosterMembers,
      currentWarIdentity: null,
      phaseTiming: buildPhaseTimingLineSource({
        roundState: activeLineup.roundState,
        startTime: activeLineup.startTime,
        endTime: activeLineup.endTime,
      }),
    },
  };
}

function buildBaseSwapClanChoices(input: {
  fwaRows: Awaited<ReturnType<typeof listFwaTrackedClansForDisplay>>;
  cwlRows: Awaited<ReturnType<typeof listCwlTrackedClansForSeason>>;
  season: string;
  query: string;
}): BaseSwapClanAutocompleteChoice[] {
  const query = String(input.query ?? "").trim().toLowerCase();
  const fwaTagSet = new Set(
    input.fwaRows
      .map((row) => normalizeClanTag(row.tag))
      .filter((tag): tag is string => Boolean(tag)),
  );
  const cwlTagSet = new Set(
    input.cwlRows
      .map((row) => normalizeClanTag(row.tag))
      .filter((tag): tag is string => Boolean(tag)),
  );

  const buildFwaChoices = input.fwaRows
    .map((row) => {
      const clanTag = normalizeClanTag(row.tag);
      if (!clanTag) return null;
      const label = buildBaseSwapAutocompleteLabel({
        clanKind: "FWA",
        clanTag,
        clanName: row.name,
        season: input.season,
        isAmbiguous: cwlTagSet.has(clanTag),
      });
      const value = buildBaseSwapAutocompleteValue({
        clanKind: "FWA",
        clanTag,
      });
      return { name: label, value };
    })
    .filter((choice): choice is BaseSwapClanAutocompleteChoice => Boolean(choice))
    .filter(
      (choice) =>
        !query ||
        choice.name.toLowerCase().includes(query) ||
        choice.value.toLowerCase().includes(query),
    );

  const buildCwlChoices = input.cwlRows
    .map((row) => {
      const clanTag = normalizeClanTag(row.tag);
      if (!clanTag) return null;
      const label = buildBaseSwapAutocompleteLabel({
        clanKind: "CWL",
        clanTag,
        clanName: row.name,
        season: input.season,
        isAmbiguous: fwaTagSet.has(clanTag),
      });
      const value = buildBaseSwapAutocompleteValue({
        clanKind: "CWL",
        clanTag,
      });
      return { name: label, value };
    })
    .filter((choice): choice is BaseSwapClanAutocompleteChoice => Boolean(choice))
    .filter(
      (choice) =>
        !query ||
        choice.name.toLowerCase().includes(query) ||
        choice.value.toLowerCase().includes(query),
    );

  const choices: BaseSwapClanAutocompleteChoice[] = [];
  let fwaIndex = 0;
  let cwlIndex = 0;
  while (
    choices.length < 25 &&
    (fwaIndex < buildFwaChoices.length || cwlIndex < buildCwlChoices.length)
  ) {
    if (fwaIndex < buildFwaChoices.length) {
      choices.push(buildFwaChoices[fwaIndex++]!);
      if (choices.length >= 25) break;
    }
    if (cwlIndex < buildCwlChoices.length) {
      choices.push(buildCwlChoices[cwlIndex++]!);
    }
  }
  return choices.slice(0, 25);
}

/** Purpose: list base-swap clan autocomplete choices across tracked FWA clans and current-season CWL clans. */
export async function buildBaseSwapClanAutocompleteChoices(input?: {
  query?: string;
  season?: string;
}): Promise<BaseSwapClanAutocompleteChoice[]> {
  const season = input?.season ?? resolveCurrentCwlSeasonKey();
  const [fwaRows, cwlRows] = await Promise.all([
    listFwaTrackedClansForDisplay(),
    listCwlTrackedClansForSeason({ season }),
  ]);
  return buildBaseSwapClanChoices({
    fwaRows,
    cwlRows,
    season,
    query: input?.query ?? "",
  });
}

/** Purpose: resolve one tracked FWA or CWL base-swap roster boundary into a roster and phase timing source. */
export async function resolveBaseSwapRosterForClan(input: {
  clanRef: string;
  guildId: string | null;
  cocService: CoCService;
  season?: string;
}): Promise<BaseSwapRosterResolutionResult> {
  const parsed = normalizeBaseSwapClanReference(input.clanRef);
  if (!parsed) {
    return {
      ok: false,
      error: "Please provide a valid `clan` tag.",
    };
  }

  const season = input.season ?? resolveCurrentCwlSeasonKey();
  if (parsed.clanKind === "FWA") {
    if (!input.guildId) {
      return {
        ok: false,
        error: "This command can only be used in a server channel.",
      };
    }
    const result = await loadFwaBaseSwapRoster({
      clanTag: parsed.clanTag,
      guildId: input.guildId,
      cocService: input.cocService,
    });
    return result;
  }

  if (parsed.clanKind === "CWL") {
    const result = await loadCwlBaseSwapRoster({
      clanTag: parsed.clanTag,
      season,
    });
    return result;
  }

  const [fwaClan, cwlClan] = await Promise.all([
    prisma.trackedClan.findFirst({
      where: {
        OR: [
          { tag: { equals: `#${parsed.clanTag}`, mode: "insensitive" } },
          { tag: { equals: parsed.clanTag, mode: "insensitive" } },
        ],
      },
      select: { tag: true },
    }),
    prisma.cwlTrackedClan.findFirst({
      where: {
        season,
        tag: { equals: `#${parsed.clanTag}`, mode: "insensitive" },
      },
      select: { tag: true },
    }),
  ]);

  const fwaFound = Boolean(fwaClan);
  const cwlFound = Boolean(cwlClan);
  if (fwaFound && cwlFound) {
    return {
      ok: false,
      error:
        `Clan ${formatClanTagForDisplay(parsed.clanTag)} exists in both FWA and current-season CWL tracked clans. ` +
        "Use the autocomplete entry with the source label you want.",
    };
  }
  if (fwaFound) {
    if (!input.guildId) {
      return {
        ok: false,
        error: "This command can only be used in a server channel.",
      };
    }
    const result = await loadFwaBaseSwapRoster({
      clanTag: parsed.clanTag,
      guildId: input.guildId,
      cocService: input.cocService,
    });
    return result;
  }
  if (cwlFound) {
    const result = await loadCwlBaseSwapRoster({
      clanTag: parsed.clanTag,
      season,
    });
    return result;
  }

  return {
    ok: false,
    error: `Clan ${formatClanTagForDisplay(parsed.clanTag)} is not in tracked FWA or current-season CWL clans.`,
  };
}
