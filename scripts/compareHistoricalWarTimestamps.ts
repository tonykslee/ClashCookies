import { readFileSync, writeFileSync } from "node:fs";

export type ClashPerkRecord = {
  sourceId: string;
  clanTag: string;
  opponentTag: string;
  timestamp: string;
};

export type DuskPerWarRecord = {
  duskWarId: string | number;
  clanTag: string;
  opponentTag: string | null;
  warStartTime: string;
  historyEndTime: string | null;
  participationRowCount: number | string;
  distinctParticipationIdentityCount: number | string;
  distinctParticipationEndTimestampCount: number | string;
  nullParticipationEndTimeCount: number | string;
  minParticipationEndTime: string | null;
  maxParticipationEndTime: string | null;
  startTimeMismatchCount: number | string;
  opponentTagMismatchCount: number | string;
  crossGuildDuplicateIdentityCount: number | string;
  crossGuildDuplicateCopyCount: number | string;
  participationEndTimeInternallyConsistent?: boolean | string | null;
};

export type HistoricalTimestampComparisonOutcome =
  | "CLOSER_TO_HISTORY"
  | "CLOSER_TO_PARTICIPATION"
  | "EQUAL_DISTANCE"
  | "UNMATCHED"
  | "AMBIGUOUS"
  | "INCONSISTENT_PARTICIPATION"
  | "MISSING_EVIDENCE";

export type HistoricalTimestampAmbiguityReason =
  | "MULTIPLE_DUSK_CANDIDATES"
  | "DUPLICATE_EXTERNAL_IDENTITY"
  | "REUSED_DUSK_IDENTITY"
  | null;

export type HistoricalTimestampComparisonRow = {
  sourceId: string;
  clanTag: string | null;
  clashPerkOpponentTag: string | null;
  clashPerkTimestamp: string | null;
  candidateMatchCount: number;
  outcome: HistoricalTimestampComparisonOutcome;
  ambiguousReason: HistoricalTimestampAmbiguityReason;
  duplicateExternalIdentity: boolean;
  duskWarId: string | null;
  duskOpponentTag: string | null;
  warStartTime: string | null;
  historyEndTime: string | null;
  participationEndTime: string | null;
  participationEndTimeInternallyInconsistent: boolean;
  participationRowCount: number | null;
  distinctParticipationIdentityCount: number | null;
  distinctParticipationEndTimestampCount: number | null;
  nullParticipationEndTimeCount: number | null;
  minParticipationEndTime: string | null;
  maxParticipationEndTime: string | null;
  startTimeMismatchCount: number | null;
  opponentTagMismatchCount: number | null;
  crossGuildDuplicateIdentityCount: number | null;
  crossGuildDuplicateCopyCount: number | null;
  clashPerkMinusDuskHistorySeconds: number | null;
  clashPerkMinusParticipationSeconds: number | null;
  historyMinusParticipationSeconds: number | null;
  closerSource: "HISTORY" | "PARTICIPATION" | "EQUAL_DISTANCE" | null;
  historyMatchesExactly: boolean | null;
  participationMatchesExactly: boolean | null;
};

export type HistoricalTimestampComparisonInput = {
  clashPerk: readonly ClashPerkRecord[];
  dusk: readonly DuskPerWarRecord[];
  windowStart: string;
  windowEnd: string;
};

export type HistoricalTimestampComparisonReport = {
  metadata: {
    clanTag: string;
    windowStart: string;
    windowEnd: string;
    matchingRule: string;
    smallOffsetDescriptionThresholdSeconds: number;
  };
  summary: {
    externalRecordCount: number;
    matchedRecordCount: number;
    candidateCountZero: number;
    candidateCountMultiple: number;
    duplicateExternalIdentityCount: number;
    reusedDuskIdentityCount: number;
    outcomeCounts: Record<HistoricalTimestampComparisonOutcome, number>;
    exactHistoryMatchCount: number;
    exactParticipationMatchCount: number;
    bothSourcesExactMatchCount: number;
    inconsistentParticipationCount: number;
    missingEvidenceCount: number;
    smallHistoryOffsetCount: number;
    smallParticipationOffsetCount: number;
  };
  analysis: {
    largestPositiveClashPerkMinusHistorySeconds: number | null;
    largestNegativeClashPerkMinusHistorySeconds: number | null;
    largestPositiveClashPerkMinusParticipationSeconds: number | null;
    largestNegativeClashPerkMinusParticipationSeconds: number | null;
    exactMatchControls: {
      history: number;
      participation: number;
      both: number;
    };
    smallOffsetSourceIds: string[];
    contradictoryParticipationSourceIds: string[];
    unmatchedOrAmbiguousSourceIds: string[];
    duplicateExternalSourceIds: string[];
    reusedDuskSourceIds: string[];
    sourceAgreement: {
      historyCloser: number;
      participationCloser: number;
      equalDistance: number;
    };
    dualSourceInterpretation: {
      discrepantTimestampPathRows: number;
      equalTimestampPathRows: number;
      unresolvedOrConflictingRows: number;
      statement: string;
    };
  };
  rows: HistoricalTimestampComparisonRow[];
};

const OUTCOMES: HistoricalTimestampComparisonOutcome[] = [
  "CLOSER_TO_HISTORY",
  "CLOSER_TO_PARTICIPATION",
  "EQUAL_DISTANCE",
  "UNMATCHED",
  "AMBIGUOUS",
  "INCONSISTENT_PARTICIPATION",
  "MISSING_EVIDENCE",
];

function text(value: unknown): string {
  return String(value ?? "").trim();
}

export function normalizeTag(value: unknown): string | null {
  const normalized = text(value).toUpperCase();
  if (!normalized) return null;
  return normalized.startsWith("#") ? normalized : `#${normalized}`;
}

function timestamp(value: unknown): number | null {
  if (value === null || value === undefined || text(value) === "") return null;
  const raw = text(value);
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw)
    ? raw
    : `${raw.replace(" ", "T")}Z`;
  const milliseconds = new Date(normalized).getTime();
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function iso(milliseconds: number | null): string | null {
  return milliseconds === null ? null : new Date(milliseconds).toISOString();
}

function count(value: unknown): number | null {
  if (value === null || value === undefined || text(value) === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function seconds(milliseconds: number): number {
  return Number((milliseconds / 1000).toFixed(3));
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      fields.push(field);
      field = "";
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error("CSV input contains an unterminated quoted field.");
  fields.push(field);
  return fields;
}

function parseInput(textValue: string): unknown {
  const trimmed = textValue.trim();
  if (!trimmed) throw new Error("Input file is empty.");
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return JSON.parse(trimmed);
  const lines = trimmed.split(/\r?\n/).filter((line) => line.trim() !== "");
  const headers = parseCsvLine(lines[0]).map((header) => header.trim());
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    return headers.reduce<Record<string, string>>((row, header, index) => {
      row[header] = values[index] ?? "";
      return row;
    }, {});
  });
}

function rowsFromInput(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && Array.isArray((value as { rows?: unknown[] }).rows)) {
    return (value as { rows: unknown[] }).rows;
  }
  throw new Error("Input must be an array or an object containing a rows array.");
}

export function normalizeClashPerk(value: unknown): ClashPerkRecord {
  const row = value as Record<string, unknown>;
  const sourceId = text(row.sourceId ?? row.clashPerkId ?? row["War ID"]);
  const clanTag = normalizeTag(row.clanTag ?? row["Clan Tag"]);
  const opponentTag = normalizeTag(row.opponentTag ?? row["Opponent Tag"]);
  const timestampValue = text(row.timestamp ?? row.clashPerkTimestamp ?? row.Date);
  const parsedTimestamp = timestamp(timestampValue);
  if (!sourceId || !clanTag || !opponentTag || parsedTimestamp === null) {
    throw new Error(`Invalid ClashPerk fixture row: ${JSON.stringify(row)}`);
  }
  return { sourceId, clanTag, opponentTag, timestamp: iso(parsedTimestamp) as string };
}

function normalizeDusk(value: unknown): DuskPerWarRecord {
  const row = value as Record<string, unknown>;
  const raw = (camel: string, snake: string): unknown => row[camel] ?? row[snake];
  const duskWarId = text(row.duskWarId ?? row.dusk_war_id);
  if (!duskWarId || !text(row.clanTag ?? row.clan_tag)) {
    throw new Error(`Invalid Dusk row identity: ${JSON.stringify(row)}`);
  }
  return {
    duskWarId,
    clanTag: normalizeTag(row.clanTag ?? row.clan_tag) ?? "",
    opponentTag: normalizeTag(row.opponentTag ?? row.opponent_tag),
    warStartTime: text(row.warStartTime ?? row.war_start_time),
    historyEndTime: text(row.historyEndTime ?? row.history_end_time) || null,
    participationRowCount: raw("participationRowCount", "participation_row_count") as string | number,
    distinctParticipationIdentityCount: raw(
      "distinctParticipationIdentityCount",
      "distinct_participation_identity_count",
    ) as string | number,
    distinctParticipationEndTimestampCount: raw(
      "distinctParticipationEndTimestampCount",
      "distinct_participation_end_timestamp_count",
    ) as string | number,
    nullParticipationEndTimeCount: raw(
      "nullParticipationEndTimeCount",
      "null_participation_end_time_count",
    ) as string | number,
    minParticipationEndTime:
      text(row.minParticipationEndTime ?? row.min_participation_end_time) || null,
    maxParticipationEndTime:
      text(row.maxParticipationEndTime ?? row.max_participation_end_time) || null,
    startTimeMismatchCount: raw("startTimeMismatchCount", "start_time_mismatch_count") as string | number,
    opponentTagMismatchCount: raw(
      "opponentTagMismatchCount",
      "opponent_tag_mismatch_count",
    ) as string | number,
    crossGuildDuplicateIdentityCount: raw(
      "crossGuildDuplicateIdentityCount",
      "cross_guild_duplicate_identity_count",
    ) as string | number,
    crossGuildDuplicateCopyCount: raw(
      "crossGuildDuplicateCopyCount",
      "cross_guild_duplicate_copy_count",
    ) as string | number,
    participationEndTimeInternallyConsistent: raw(
      "participationEndTimeInternallyConsistent",
      "participation_end_time_internally_consistent",
    ) as boolean | string | null | undefined,
  };
}

function field(row: DuskPerWarRecord, key: keyof DuskPerWarRecord): number | null {
  return count(row[key]);
}

function consistentParticipation(row: DuskPerWarRecord): boolean {
  const rowCount = field(row, "participationRowCount");
  const distinctEndCount = field(row, "distinctParticipationEndTimestampCount");
  const nullEndCount = field(row, "nullParticipationEndTimeCount");
  const minimum = timestamp(row.minParticipationEndTime);
  const maximum = timestamp(row.maxParticipationEndTime);
  const declaredConsistency = text(row.participationEndTimeInternallyConsistent).toLowerCase();
  return (
    rowCount !== null &&
    rowCount > 0 &&
    distinctEndCount === 1 &&
    nullEndCount === 0 &&
    minimum !== null &&
    maximum !== null &&
    minimum === maximum &&
    declaredConsistency !== "false" &&
    declaredConsistency !== "f" &&
    declaredConsistency !== "0"
  );
}

function baseRow(external: ClashPerkRecord, candidateMatchCount: number): HistoricalTimestampComparisonRow {
  return {
    sourceId: external.sourceId,
    clanTag: external.clanTag,
    clashPerkOpponentTag: external.opponentTag,
    clashPerkTimestamp: external.timestamp,
    candidateMatchCount,
    outcome: candidateMatchCount === 0 ? "UNMATCHED" : "AMBIGUOUS",
    ambiguousReason: candidateMatchCount > 1 ? "MULTIPLE_DUSK_CANDIDATES" : null,
    duplicateExternalIdentity: false,
    duskWarId: null,
    duskOpponentTag: null,
    warStartTime: null,
    historyEndTime: null,
    participationEndTime: null,
    participationEndTimeInternallyInconsistent: false,
    participationRowCount: null,
    distinctParticipationIdentityCount: null,
    distinctParticipationEndTimestampCount: null,
    nullParticipationEndTimeCount: null,
    minParticipationEndTime: null,
    maxParticipationEndTime: null,
    startTimeMismatchCount: null,
    opponentTagMismatchCount: null,
    crossGuildDuplicateIdentityCount: null,
    crossGuildDuplicateCopyCount: null,
    clashPerkMinusDuskHistorySeconds: null,
    clashPerkMinusParticipationSeconds: null,
    historyMinusParticipationSeconds: null,
    closerSource: null,
    historyMatchesExactly: null,
    participationMatchesExactly: null,
  };
}

export function compareHistoricalWarTimestamps(
  input: HistoricalTimestampComparisonInput,
): HistoricalTimestampComparisonReport {
  const windowStart = timestamp(input.windowStart);
  const windowEnd = timestamp(input.windowEnd);
  if (windowStart === null || windowEnd === null || windowEnd <= windowStart) {
    throw new Error("The comparison window must be a valid increasing UTC interval.");
  }
  const external = input.clashPerk.map(normalizeClashPerk);
  const dusk = input.dusk.map(normalizeDusk);
  const candidateLists = external.map((externalRow) => {
    const externalTime = timestamp(externalRow.timestamp);
    if (externalTime === null || externalTime < windowStart || externalTime >= windowEnd) return [];
    return dusk.filter((duskRow) => {
      const historyEnd = timestamp(duskRow.historyEndTime);
      return (
        duskRow.clanTag === externalRow.clanTag &&
        normalizeTag(duskRow.opponentTag) === externalRow.opponentTag &&
        historyEnd !== null &&
        historyEnd >= windowStart &&
        historyEnd < windowEnd
      );
    });
  });
  const externalIdentityCounts = new Map<string, number>();
  const externalSourceIdCounts = new Map<string, number>();
  external.forEach((externalRow) => {
    const identityKey = `${externalRow.clanTag}|${externalRow.opponentTag}|${externalRow.timestamp}`;
    externalIdentityCounts.set(identityKey, (externalIdentityCounts.get(identityKey) ?? 0) + 1);
    externalSourceIdCounts.set(externalRow.sourceId, (externalSourceIdCounts.get(externalRow.sourceId) ?? 0) + 1);
  });
  const externalIdentityDuplicate = external.map((externalRow) => {
    const identityKey = `${externalRow.clanTag}|${externalRow.opponentTag}|${externalRow.timestamp}`;
    return (externalIdentityCounts.get(identityKey) ?? 0) > 1 ||
      (externalSourceIdCounts.get(externalRow.sourceId) ?? 0) > 1;
  });
  const candidateUseCounts = new Map<string, number>();
  candidateLists.forEach((candidates) => {
    if (candidates.length !== 1) return;
    const candidate = candidates[0];
    const identityKey = `${candidate.clanTag}|${normalizeTag(candidate.opponentTag)}|${text(candidate.duskWarId)}`;
    candidateUseCounts.set(identityKey, (candidateUseCounts.get(identityKey) ?? 0) + 1);
  });
  const reusedDuskIdentity = candidateLists.map((candidates) => {
    if (candidates.length !== 1) return false;
    const candidate = candidates[0];
    const identityKey = `${candidate.clanTag}|${normalizeTag(candidate.opponentTag)}|${text(candidate.duskWarId)}`;
    return (candidateUseCounts.get(identityKey) ?? 0) > 1;
  });
  const rows = external.map((externalRow, index) => {
    const externalTime = timestamp(externalRow.timestamp);
    const candidates = candidateLists[index];
    const result = baseRow(externalRow, candidates.length);
    result.duplicateExternalIdentity = externalIdentityDuplicate[index];
    if (externalTime === null || externalTime < windowStart || externalTime >= windowEnd) {
      result.outcome = "MISSING_EVIDENCE";
      return result;
    }
    if (candidates.length !== 1) {
      result.outcome = candidates.length > 1 ? "AMBIGUOUS" : "UNMATCHED";
      result.ambiguousReason = candidates.length > 1 ? "MULTIPLE_DUSK_CANDIDATES" : null;
      return result;
    }
    if (externalIdentityDuplicate[index]) {
      result.outcome = "AMBIGUOUS";
      result.ambiguousReason = "DUPLICATE_EXTERNAL_IDENTITY";
      return result;
    }
    if (reusedDuskIdentity[index]) {
      result.outcome = "AMBIGUOUS";
      result.ambiguousReason = "REUSED_DUSK_IDENTITY";
      return result;
    }

    const candidate = candidates[0];
    const historyEnd = timestamp(candidate.historyEndTime);
    const participationEnd = timestamp(candidate.minParticipationEndTime);
    const participationIsConsistent = consistentParticipation(candidate);
    result.duskWarId = text(candidate.duskWarId);
    result.duskOpponentTag = normalizeTag(candidate.opponentTag);
    result.warStartTime = iso(timestamp(candidate.warStartTime));
    result.historyEndTime = iso(historyEnd);
    result.participationEndTime = participationIsConsistent ? iso(participationEnd) : null;
    result.participationEndTimeInternallyInconsistent = !participationIsConsistent;
    result.participationRowCount = field(candidate, "participationRowCount");
    result.distinctParticipationIdentityCount = field(candidate, "distinctParticipationIdentityCount");
    result.distinctParticipationEndTimestampCount = field(candidate, "distinctParticipationEndTimestampCount");
    result.nullParticipationEndTimeCount = field(candidate, "nullParticipationEndTimeCount");
    result.minParticipationEndTime = iso(timestamp(candidate.minParticipationEndTime));
    result.maxParticipationEndTime = iso(timestamp(candidate.maxParticipationEndTime));
    result.startTimeMismatchCount = field(candidate, "startTimeMismatchCount");
    result.opponentTagMismatchCount = field(candidate, "opponentTagMismatchCount");
    result.crossGuildDuplicateIdentityCount = field(candidate, "crossGuildDuplicateIdentityCount");
    result.crossGuildDuplicateCopyCount = field(candidate, "crossGuildDuplicateCopyCount");

    if (historyEnd === null || result.participationRowCount === null || result.participationRowCount === 0) {
      result.outcome = "MISSING_EVIDENCE";
      return result;
    }
    if (!participationIsConsistent || participationEnd === null) {
      result.outcome = "INCONSISTENT_PARTICIPATION";
      return result;
    }

    const historyOffset = seconds(externalTime - historyEnd);
    const participationOffset = seconds(externalTime - participationEnd);
    const historyDistance = Math.abs(historyOffset);
    const participationDistance = Math.abs(participationOffset);
    result.clashPerkMinusDuskHistorySeconds = historyOffset;
    result.clashPerkMinusParticipationSeconds = participationOffset;
    result.historyMinusParticipationSeconds = seconds(historyEnd - participationEnd);
    result.historyMatchesExactly = historyOffset === 0;
    result.participationMatchesExactly = participationOffset === 0;
    if (historyDistance < participationDistance) {
      result.outcome = "CLOSER_TO_HISTORY";
      result.closerSource = "HISTORY";
    } else if (participationDistance < historyDistance) {
      result.outcome = "CLOSER_TO_PARTICIPATION";
      result.closerSource = "PARTICIPATION";
    } else {
      result.outcome = "EQUAL_DISTANCE";
      result.closerSource = "EQUAL_DISTANCE";
    }
    return result;
  });

  const sortedRows = [...rows].sort((left, right) =>
    `${left.clashPerkTimestamp ?? ""}|${left.clashPerkOpponentTag ?? ""}|${left.sourceId}`.localeCompare(
      `${right.clashPerkTimestamp ?? ""}|${right.clashPerkOpponentTag ?? ""}|${right.sourceId}`,
    ),
  );
  const outcomeCounts = OUTCOMES.reduce<Record<HistoricalTimestampComparisonOutcome, number>>(
    (counts, outcome) => {
      counts[outcome] = rows.filter((row) => row.outcome === outcome).length;
      return counts;
    },
    {} as Record<HistoricalTimestampComparisonOutcome, number>,
  );
  const validRows = rows.filter((row) => row.clashPerkMinusDuskHistorySeconds !== null);
  const smallOffsetThreshold = 2;
  const historyOffsets = validRows.map((row) => row.clashPerkMinusDuskHistorySeconds as number);
  const participationOffsets = validRows.map((row) => row.clashPerkMinusParticipationSeconds as number);
  const extrema = (values: number[], positive: boolean): number | null => {
    const filtered = values.filter((value) => (positive ? value > 0 : value < 0));
    if (filtered.length === 0) return null;
    return positive ? Math.max(...filtered) : Math.min(...filtered);
  };
  const smallRows = rows.filter(
    (row) =>
      (row.clashPerkMinusDuskHistorySeconds !== null &&
        Math.abs(row.clashPerkMinusDuskHistorySeconds) <= smallOffsetThreshold) ||
      (row.clashPerkMinusParticipationSeconds !== null &&
        Math.abs(row.clashPerkMinusParticipationSeconds) <= smallOffsetThreshold),
  );
  const discrepantTimestampPathRows = rows.filter(
    (row) => row.historyMinusParticipationSeconds !== null && row.historyMinusParticipationSeconds !== 0,
  ).length;
  const equalTimestampPathRows = rows.filter(
    (row) => row.historyMinusParticipationSeconds === 0,
  ).length;
  const unresolvedOrConflictingRows = rows.filter(
    (row) => row.outcome === "UNMATCHED" || row.outcome === "AMBIGUOUS" || row.outcome === "INCONSISTENT_PARTICIPATION" || row.outcome === "MISSING_EVIDENCE",
  ).length;
  return {
    metadata: {
      clanTag: normalizeTag(input.clashPerk[0]?.clanTag) ?? "",
      windowStart: new Date(windowStart).toISOString(),
      windowEnd: new Date(windowEnd).toISOString(),
      matchingRule: "Unique clan tag + normalized opponent tag within the fixed UTC window; no numeric ID or tolerance-based selection.",
      smallOffsetDescriptionThresholdSeconds: smallOffsetThreshold,
    },
    summary: {
      externalRecordCount: rows.length,
      matchedRecordCount: rows.filter((row) => row.duskWarId !== null).length,
      candidateCountZero: rows.filter((row) => row.candidateMatchCount === 0).length,
      candidateCountMultiple: rows.filter((row) => row.candidateMatchCount > 1).length,
      duplicateExternalIdentityCount: rows.filter((row) => row.duplicateExternalIdentity).length,
      reusedDuskIdentityCount: rows.filter((row) => row.ambiguousReason === "REUSED_DUSK_IDENTITY").length,
      outcomeCounts,
      exactHistoryMatchCount: rows.filter((row) => row.historyMatchesExactly === true).length,
      exactParticipationMatchCount: rows.filter((row) => row.participationMatchesExactly === true).length,
      bothSourcesExactMatchCount: rows.filter(
        (row) => row.historyMatchesExactly === true && row.participationMatchesExactly === true,
      ).length,
      inconsistentParticipationCount: outcomeCounts.INCONSISTENT_PARTICIPATION,
      missingEvidenceCount: outcomeCounts.MISSING_EVIDENCE,
      smallHistoryOffsetCount: rows.filter(
        (row) => row.clashPerkMinusDuskHistorySeconds !== null && Math.abs(row.clashPerkMinusDuskHistorySeconds) <= smallOffsetThreshold,
      ).length,
      smallParticipationOffsetCount: rows.filter(
        (row) => row.clashPerkMinusParticipationSeconds !== null && Math.abs(row.clashPerkMinusParticipationSeconds) <= smallOffsetThreshold,
      ).length,
    },
    analysis: {
      largestPositiveClashPerkMinusHistorySeconds: extrema(historyOffsets, true),
      largestNegativeClashPerkMinusHistorySeconds: extrema(historyOffsets, false),
      largestPositiveClashPerkMinusParticipationSeconds: extrema(participationOffsets, true),
      largestNegativeClashPerkMinusParticipationSeconds: extrema(participationOffsets, false),
      exactMatchControls: {
        history: rows.filter((row) => row.historyMatchesExactly === true).length,
        participation: rows.filter((row) => row.participationMatchesExactly === true).length,
        both: rows.filter(
          (row) => row.historyMatchesExactly === true && row.participationMatchesExactly === true,
        ).length,
      },
      smallOffsetSourceIds: smallRows.map((row) => row.sourceId),
      contradictoryParticipationSourceIds: rows
        .filter((row) => row.outcome === "INCONSISTENT_PARTICIPATION")
        .map((row) => row.sourceId),
      unmatchedOrAmbiguousSourceIds: rows
        .filter((row) => row.outcome === "UNMATCHED" || row.outcome === "AMBIGUOUS")
        .map((row) => row.sourceId),
      duplicateExternalSourceIds: rows
        .filter((row) => row.duplicateExternalIdentity)
        .map((row) => row.sourceId),
      reusedDuskSourceIds: rows
        .filter((row) => row.ambiguousReason === "REUSED_DUSK_IDENTITY")
        .map((row) => row.sourceId),
      sourceAgreement: {
        historyCloser: outcomeCounts.CLOSER_TO_HISTORY,
        participationCloser: outcomeCounts.CLOSER_TO_PARTICIPATION,
        equalDistance: outcomeCounts.EQUAL_DISTANCE,
      },
      dualSourceInterpretation: {
        discrepantTimestampPathRows,
        equalTimestampPathRows,
        unresolvedOrConflictingRows,
        statement:
          "Only rows where the two Dusk timestamps differ are relevant to testing the dual-source discrepancy. Timestamp proximity remains corroboration only; it does not establish source authenticity, authority, or which Dusk path is historically correct.",
      },
    },
    rows: sortedRows,
  };
}

function argumentValue(argv: string[], name: string): string {
  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

export function runHistoricalTimestampComparator(argv: string[]): HistoricalTimestampComparisonReport {
  const clashPerkPath = argumentValue(argv, "--clashperk");
  const duskPath = argumentValue(argv, "--dusk");
  const outputPath = argv.includes("--output") ? argumentValue(argv, "--output") : null;
  const clashPerkParsed = parseInput(readFileSync(clashPerkPath, "utf8"));
  const clashPerkMetadata =
    clashPerkParsed && typeof clashPerkParsed === "object" && !Array.isArray(clashPerkParsed)
      ? (clashPerkParsed as { metadata?: Record<string, unknown> }).metadata ?? {}
      : {};
  const clashPerkInput = rowsFromInput(clashPerkParsed).map((row) =>
    normalizeClashPerk({
      ...(row as Record<string, unknown>),
      clanTag:
        (row as Record<string, unknown>).clanTag ??
        (row as Record<string, unknown>)["Clan Tag"] ??
        clashPerkMetadata.clanTag,
    }),
  );
  const duskInput = rowsFromInput(parseInput(readFileSync(duskPath, "utf8"))).map(normalizeDusk);
  const report = compareHistoricalWarTimestamps({
    clashPerk: clashPerkInput,
    dusk: duskInput,
    windowStart: "2026-09-23T00:00:00.000Z",
    windowEnd: "2026-11-22T00:00:00.000Z",
  });
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (outputPath) writeFileSync(outputPath, serialized, "utf8");
  else process.stdout.write(serialized);
  return report;
}

if (require.main === module) {
  try {
    runHistoricalTimestampComparator(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
