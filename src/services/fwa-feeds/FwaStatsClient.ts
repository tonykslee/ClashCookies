import axios, { AxiosError } from "axios";
import { recordFetchEvent } from "../../helper/fetchTelemetry";
import {
  normalizeFwaTag,
  normalizeFwaTagBare,
  normalizeText,
  toBoolOrNull,
  toDateOrNull,
  toFloatOrNull,
  toIntOrNull,
} from "./normalize";
import type {
  FwaClanMemberFeedRow,
  FwaClanWarsFeedRow,
  FwaClansFeedRow,
  FwaWarMemberFeedRow,
} from "./types";

type FeedOperation = "clans_json" | "clan_members_json" | "war_members_json" | "clan_wars_json";

type FetchRowsParams = {
  operation: FeedOperation;
  url: string;
  scope: string;
};

type FetchRowsResult = {
  rows: unknown[];
  durationMs: number;
};

/** Purpose: centralize all fwastats JSON-feed HTTP calls, parsing, retries, and telemetry. */
export class FwaStatsClient {
  private readonly timeoutMs: number;
  private readonly retryCount: number;

  /** Purpose: configure network safety bounds for fwastats feed requests. */
  constructor(params?: { timeoutMs?: number; retryCount?: number }) {
    const envTimeout = toIntOrNull(process.env.FWA_FEED_REQUEST_TIMEOUT_MS);
    const envRetry = toIntOrNull(process.env.FWA_FEED_RETRY_COUNT);
    const timeoutMs = params?.timeoutMs ?? envTimeout ?? 5000;
    const retryCount = params?.retryCount ?? envRetry ?? 1;
    this.timeoutMs = Math.max(1000, timeoutMs);
    this.retryCount = Math.max(0, Math.min(5, retryCount));
  }

  /** Purpose: fetch and parse global active FWA clan catalog rows from `Clans.json`. */
  async fetchClans(): Promise<FwaClansFeedRow[]> {
    const { rows } = await this.fetchRows({
      operation: "clans_json",
      url: "https://fwastats.com/Clans.json",
      scope: "global",
    });
    return rows
      .map((row) => this.parseClansRow(row))
      .filter((row): row is FwaClansFeedRow => Boolean(row));
  }

  /** Purpose: fetch and parse one tracked clan current member roster from `Members.json`. */
  async fetchClanMembers(clanTag: string): Promise<FwaClanMemberFeedRow[]> {
    const normalizedTag = normalizeFwaTag(clanTag);
    const bare = normalizeFwaTagBare(clanTag);
    if (!normalizedTag || !bare) return [];
    const { rows } = await this.fetchRows({
      operation: "clan_members_json",
      url: `https://fwastats.com/Clan/${bare}/Members.json`,
      scope: normalizedTag,
    });
    return rows
      .map((row) => this.parseClanMembersRow(normalizedTag, row))
      .filter((row): row is FwaClanMemberFeedRow => Boolean(row));
  }

  /** Purpose: fetch and parse one clan active-war roster rows from `WarMembers.json?warNo=1`. */
  async fetchWarMembers(clanTag: string): Promise<FwaWarMemberFeedRow[]> {
    const normalizedTag = normalizeFwaTag(clanTag);
    const bare = normalizeFwaTagBare(clanTag);
    if (!normalizedTag || !bare) return [];
    const { rows } = await this.fetchRows({
      operation: "war_members_json",
      url: `https://fwastats.com/Clan/${bare}/WarMembers.json?warNo=1`,
      scope: normalizedTag,
    });
    return rows
      .map((row) => this.parseWarMembersRow(normalizedTag, row))
      .filter((row): row is FwaWarMemberFeedRow => Boolean(row));
  }

  /** Purpose: fetch and parse one clan recent war summary rows from `Wars.json`. */
  async fetchClanWars(clanTag: string): Promise<FwaClanWarsFeedRow[]> {
    const normalizedTag = normalizeFwaTag(clanTag);
    const bare = normalizeFwaTagBare(clanTag);
    if (!normalizedTag || !bare) return [];
    const { rows } = await this.fetchRows({
      operation: "clan_wars_json",
      url: `https://fwastats.com/Clan/${bare}/Wars.json`,
      scope: normalizedTag,
    });
    return rows
      .map((row) => this.parseClanWarsRow(normalizedTag, row))
      .filter((row): row is FwaClanWarsFeedRow => Boolean(row));
  }

  /** Purpose: perform bounded-retry JSON fetches with concise operation telemetry. */
  private async fetchRows(params: FetchRowsParams): Promise<FetchRowsResult> {
    const startedAtMs = Date.now();
    let lastError: unknown = null;
    const maxAttempts = this.retryCount + 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const response = await axios.get<unknown>(params.url, {
          timeout: this.timeoutMs,
          validateStatus: () => true,
        });
        const durationMs = Date.now() - startedAtMs;
        if (response.status >= 200 && response.status < 300) {
          const rows = Array.isArray(response.data) ? response.data : [];
          recordFetchEvent({
            namespace: "fwastats_feed",
            operation: params.operation,
            source: "web",
            detail: `scope=${params.scope} rows=${rows.length} attempt=${attempt}`,
            durationMs,
            status: "success",
          });
          return { rows, durationMs };
        }
        lastError = new Error(`HTTP_${response.status}`);
        if (response.status < 500 || attempt >= maxAttempts) {
          throw lastError;
        }
      } catch (error) {
        lastError = error;
        const status = (error as AxiosError)?.response?.status;
        const timeout = (error as AxiosError)?.code === "ECONNABORTED";
        if (attempt < maxAttempts && (timeout || (status !== undefined && status >= 500))) {
          continue;
        }
        const durationMs = Date.now() - startedAtMs;
        recordFetchEvent({
          namespace: "fwastats_feed",
          operation: params.operation,
          source: "web",
          detail: `scope=${params.scope} attempt=${attempt}`,
          durationMs,
          status: "failure",
          errorCategory: status !== undefined ? "http" : "network",
          errorCode: status !== undefined ? `HTTP_${status}` : "REQUEST_FAILED",
          timeout,
        });
        throw error;
      }
    }
    throw lastError ?? new Error("Unknown fwastats fetch failure");
  }

  /** Purpose: map one `Clans.json` row into normalized catalog shape. */
  private parseClansRow(input: unknown): FwaClansFeedRow | null {
    const row = this.asRecord(input);
    if (!row) return null;
    const clanTag = normalizeFwaTag(String(row.tag ?? ""));
    const name = normalizeText(row.name);
    if (!clanTag || !name) return null;
    return {
      clanTag,
      name,
      level: toIntOrNull(row.level),
      points: toIntOrNull(row.points),
      type: normalizeText(row.type),
      location: normalizeText(row.location),
      requiredTrophies: toIntOrNull(row.requiredTrophies),
      warFrequency: normalizeText(row.warFrequency),
      winStreak: toIntOrNull(row.winStreak),
      wins: toIntOrNull(row.wins),
      ties: toIntOrNull(row.ties),
      losses: toIntOrNull(row.losses),
      isWarLogPublic: toBoolOrNull(row.isWarLogPublic),
      imageUrl: normalizeText(row.image),
      description: normalizeText(row.description),
      th18Count: toIntOrNull(row.th18Count),
      th17Count: toIntOrNull(row.th17Count),
      th16Count: toIntOrNull(row.th16Count),
      th15Count: toIntOrNull(row.th15Count),
      th14Count: toIntOrNull(row.th14Count),
      th13Count: toIntOrNull(row.th13Count),
      th12Count: toIntOrNull(row.th12Count),
      th11Count: toIntOrNull(row.th11Count),
      th10Count: toIntOrNull(row.th10Count),
      th9Count: toIntOrNull(row.th9Count),
      th8Count: toIntOrNull(row.th8Count),
      thLowCount: toIntOrNull(row.thLowCount),
      estimatedWeight: toIntOrNull(row.estimatedWeight),
    };
  }

  /** Purpose: map one `Members.json` row into normalized tracked-roster shape. */
  private parseClanMembersRow(clanTag: string, input: unknown): FwaClanMemberFeedRow | null {
    const row = this.asRecord(input);
    if (!row) return null;
    const playerTag = normalizeFwaTag(String(row.tag ?? ""));
    const playerName = normalizeText(row.name);
    if (!playerTag || !playerName) return null;
    return {
      clanTag,
      playerTag,
      playerName,
      role: normalizeText(row.role),
      level: toIntOrNull(row.level),
      donated: toIntOrNull(row.donated),
      received: toIntOrNull(row.received),
      rank: toIntOrNull(row.rank),
      trophies: toIntOrNull(row.trophies),
      league: normalizeText(row.league),
      townHall: toIntOrNull(row.townHall),
      weight: toIntOrNull(row.weight),
      inWar: toBoolOrNull(row.inWar),
    };
  }

  /** Purpose: map one `WarMembers.json` row into normalized war-roster shape. */
  private parseWarMembersRow(clanTag: string, input: unknown): FwaWarMemberFeedRow | null {
    const row = this.asRecord(input);
    if (!row) return null;
    const playerTag = normalizeFwaTag(String(row.tag ?? ""));
    const playerName = normalizeText(row.name);
    if (!playerTag || !playerName) return null;
    return {
      clanTag,
      playerTag,
      playerName,
      position: toIntOrNull(row.position),
      townHall: toIntOrNull(row.townHall),
      weight: toIntOrNull(row.weight),
      opponentTag: normalizeText(row.opponentTag)
        ? normalizeFwaTag(String(row.opponentTag))
        : null,
      opponentName: normalizeText(row.opponentName),
      attacks: toIntOrNull(row.attacks),
      defender1Tag: normalizeText(row.defender1Tag)
        ? normalizeFwaTag(String(row.defender1Tag))
        : null,
      defender1Name: normalizeText(row.defender1Name),
      defender1TownHall: toIntOrNull(row.defender1TownHall),
      defender1Position: toIntOrNull(row.defender1Position),
      stars1: toIntOrNull(row.stars1),
      destructionPercentage1: toFloatOrNull(row.destructionPercentage1),
      defender2Tag: normalizeText(row.defender2Tag)
        ? normalizeFwaTag(String(row.defender2Tag))
        : null,
      defender2Name: normalizeText(row.defender2Name),
      defender2TownHall: toIntOrNull(row.defender2TownHall),
      defender2Position: toIntOrNull(row.defender2Position),
      stars2: toIntOrNull(row.stars2),
      destructionPercentage2: toFloatOrNull(row.destructionPercentage2),
    };
  }

  /** Purpose: map one `Wars.json` row into normalized clan-war-log shape. */
  private parseClanWarsRow(clanTag: string, input: unknown): FwaClanWarsFeedRow | null {
    const row = this.asRecord(input);
    if (!row) return null;
    const endTime = toDateOrNull(row.endTime);
    const teamSize = toIntOrNull(row.teamSize);
    const normalizedOpponent = normalizeFwaTag(String(row.opponentTag ?? ""));
    if (!endTime || teamSize === null || !normalizedOpponent) return null;
    return {
      clanTag: normalizeFwaTag(String(row.clanTag ?? clanTag)) || clanTag,
      endTime,
      searchTime: toDateOrNull(row.searchTime),
      result: normalizeText(row.result),
      teamSize,
      clanName: normalizeText(row.clanName),
      clanLevel: toIntOrNull(row.clanLevel),
      clanStars: toIntOrNull(row.clanStars),
      clanDestructionPercentage: toFloatOrNull(row.clanDestructionPercentage),
      clanAttacks: toIntOrNull(row.clanAttacks),
      clanExpEarned: toIntOrNull(row.clanExpEarned),
      opponentTag: normalizedOpponent,
      opponentName: normalizeText(row.opponentName),
      opponentLevel: toIntOrNull(row.opponentLevel),
      opponentStars: toIntOrNull(row.opponentStars),
      opponentDestructionPercentage: toFloatOrNull(row.opponentDestructionPercentage),
      opponentInfo: normalizeText(row.opponentInfo),
      synced: toBoolOrNull(row.synced),
      matched: toBoolOrNull(row.matched),
    };
  }

  /** Purpose: safely narrow unknown JSON values into object records. */
  private asRecord(input: unknown): Record<string, unknown> | null {
    if (!input || typeof input !== "object" || Array.isArray(input)) return null;
    return input as Record<string, unknown>;
  }
}
