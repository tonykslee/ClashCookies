import axios, { AxiosError } from "axios";
import {
  ClanWarLogEntry,
  ClanWar,
  ClanWarLeagueGroup,
  ClansApi,
  Configuration,
  Player,
  PlayersApi,
} from "../generated/coc-api";
import { recordFetchEvent } from "../helper/fetchTelemetry";
import { toFailureTelemetry } from "./telemetry/ingest";
import { cocRequestQueueService } from "./CoCRequestQueueService";

export class CoCService {
  private clansApi: ClansApi;
  private playersApi: PlayersApi;
  private readonly cocApiToken: string;
  private readonly cocApiBaseUrl: string;
  private readonly queue = cocRequestQueueService;

  /** Purpose: initialize service dependencies. */
  constructor() {
    const token = process.env.COC_API_TOKEN?.trim();
    if (!token) throw new Error("COC_API_TOKEN missing");
    this.cocApiToken = token;
    this.cocApiBaseUrl =
      (process.env.COC_API_BASE_URL ?? "https://api.clashofclans.com/v1").replace(
        /\/+$/,
        "",
      );

    const config = new Configuration({
      apiKey: `Bearer ${token}`,
      basePath: this.cocApiBaseUrl,
    });

    this.clansApi = new ClansApi(config);
    this.playersApi = new PlayersApi(config);
  }

  /** Purpose: run one outbound CoC API call through shared queue pacing. */
  private async runQueuedRequest<T>(input: {
    operation: string;
    detail: string;
    run: () => Promise<T>;
  }): Promise<T> {
    return this.queue.enqueue({
      operation: input.operation,
      detail: input.detail,
      run: input.run,
    });
  }

  /** Purpose: get current clan-capital raid seasons for one clan tag (newest first). */
  async getClanCapitalRaidSeasons(
    tag: string,
    limit = 1,
  ): Promise<ClanCapitalRaidSeason[]> {
    const clanTag = tag.startsWith("#") ? tag : `#${tag}`;
    const startedAtMs = Date.now();
    try {
      const response = await this.runQueuedRequest({
        operation: "getClanCapitalRaidSeasons",
        detail: `tag=${clanTag}`,
        run: () =>
          axios.get(
            `${this.cocApiBaseUrl}/clans/${encodeURIComponent(clanTag)}/capitalraidseasons`,
            {
              headers: {
                Authorization: `Bearer ${this.cocApiToken}`,
              },
              params: {
                limit: Math.max(1, Math.trunc(Number(limit) || 1)),
              },
            },
          ),
      });
      const data = response?.data as { items?: ClanCapitalRaidSeason[] } | undefined;
      const seasons = Array.isArray(data?.items) ? data.items : [];
      recordFetchEvent({
        namespace: "coc",
        operation: "getClanCapitalRaidSeasons",
        source: "api",
        detail: `tag=${clanTag} limit=${limit}`,
        durationMs: Date.now() - startedAtMs,
        status: "success",
      });
      return seasons;
    } catch (err) {
      const status = (err as AxiosError)?.response?.status;
      const failure = toFailureTelemetry(err);
      if (status === 404) {
        recordFetchEvent({
          namespace: "coc",
          operation: "getClanCapitalRaidSeasons",
          source: "api",
          detail: `tag=${clanTag} status=404`,
          durationMs: Date.now() - startedAtMs,
          status: "failure",
          errorCategory: "validation",
          errorCode: "HTTP_404",
        });
        return [];
      }
      recordFetchEvent({
        namespace: "coc",
        operation: "getClanCapitalRaidSeasons",
        source: "api",
        detail: `tag=${clanTag} status=${status ?? "unknown"} result=error`,
        durationMs: Date.now() - startedAtMs,
        status: "failure",
        errorCategory: failure.errorCategory,
        errorCode: failure.errorCode,
        timeout: failure.timeout,
      });
      if (status) throw new Error(`CoC API error ${status}`);
      throw err;
    }
  }

  /** Purpose: get clan. */
  async getClan(tag: string): Promise<any> {
    const clanTag = tag.startsWith("#") ? tag : `#${tag}`;
    const startedAtMs = Date.now();
    try {
      const { data } = await this.runQueuedRequest({
        operation: "getClan",
        detail: `tag=${clanTag}`,
        run: () => this.clansApi.getClan(clanTag),
      });
      recordFetchEvent({
        namespace: "coc",
        operation: "getClan",
        source: "api",
        detail: `tag=${clanTag}`,
        durationMs: Date.now() - startedAtMs,
        status: "success",
      });

      // Preserve existing call sites that expect `clan.members`.
      return {
        ...data,
        tag: data.tag ?? "",
        name: data.name ?? "Unknown Clan",
        members: data.memberList ?? [],
      };
    } catch (err) {
      const failure = toFailureTelemetry(err);
      recordFetchEvent({
        namespace: "coc",
        operation: "getClan",
        source: "api",
        detail: `tag=${clanTag} result=error`,
        durationMs: Date.now() - startedAtMs,
        status: "failure",
        errorCategory: failure.errorCategory,
        errorCode: failure.errorCode,
        timeout: failure.timeout,
      });
      throw err;
    }
  }

  /** Purpose: get clan name. */
  async getClanName(tag: string): Promise<string> {
    const clan = await this.getClan(tag);
    return clan.name ?? "Unknown Clan";
  }

  /** Purpose: get current war. */
  async getCurrentWar(tag: string): Promise<ClanWar | null> {
    const clanTag = tag.startsWith("#") ? tag : `#${tag}`;
    const startedAtMs = Date.now();
    try {
      const { data } = await this.runQueuedRequest({
        operation: "getCurrentWar",
        detail: `tag=${clanTag}`,
        run: () => this.clansApi.getCurrentWar(clanTag),
      });
      recordFetchEvent({
        namespace: "coc",
        operation: "getCurrentWar",
        source: "api",
        detail: `tag=${clanTag}`,
        durationMs: Date.now() - startedAtMs,
        status: "success",
      });
      return data;
    } catch (err) {
      const status = (err as AxiosError)?.response?.status;
      const failure = toFailureTelemetry(err);
      if (status === 404) {
        recordFetchEvent({
          namespace: "coc",
          operation: "getCurrentWar",
          source: "api",
          detail: `tag=${clanTag} status=404`,
          durationMs: Date.now() - startedAtMs,
          status: "failure",
          errorCategory: "validation",
          errorCode: "HTTP_404",
        });
        return null;
      }
      recordFetchEvent({
        namespace: "coc",
        operation: "getCurrentWar",
        source: "api",
        detail: `tag=${clanTag} status=${status ?? "unknown"} result=error`,
        durationMs: Date.now() - startedAtMs,
        status: "failure",
        errorCategory: failure.errorCategory,
        errorCode: failure.errorCode,
        timeout: failure.timeout,
      });
      if (status) throw new Error(`CoC API error ${status}`);
      throw err;
    }
  }

  /** Purpose: get clan war log. */
  async getClanWarLog(tag: string, limit = 10): Promise<ClanWarLogEntry[]> {
    const clanTag = tag.startsWith("#") ? tag : `#${tag}`;
    const startedAtMs = Date.now();
    try {
      const { data } = await this.runQueuedRequest({
        operation: "getClanWarLog",
        detail: `tag=${clanTag} limit=${limit}`,
        run: () => this.clansApi.getClanWarLog(clanTag, limit),
      });
      recordFetchEvent({
        namespace: "coc",
        operation: "getClanWarLog",
        source: "api",
        detail: `tag=${clanTag} limit=${limit}`,
        durationMs: Date.now() - startedAtMs,
        status: "success",
      });
      return Array.isArray(data.items) ? data.items : [];
    } catch (err) {
      const status = (err as AxiosError)?.response?.status;
      const failure = toFailureTelemetry(err);
      recordFetchEvent({
        namespace: "coc",
        operation: "getClanWarLog",
        source: "api",
        detail: `tag=${clanTag} status=${status ?? "unknown"} result=error`,
        durationMs: Date.now() - startedAtMs,
        status: "failure",
        errorCategory: failure.errorCategory,
        errorCode: failure.errorCode,
        timeout: failure.timeout,
      });
      return [];
    }
  }

  /** Purpose: get clan war league group for a clan. */
  async getClanWarLeagueGroup(tag: string): Promise<ClanWarLeagueGroup | null> {
    const clanTag = tag.startsWith("#") ? tag : `#${tag}`;
    const startedAtMs = Date.now();
    try {
      const { data } = await this.runQueuedRequest({
        operation: "getClanWarLeagueGroup",
        detail: `tag=${clanTag}`,
        run: () => this.clansApi.getClanWarLeagueGroup(clanTag),
      });
      recordFetchEvent({
        namespace: "coc",
        operation: "getClanWarLeagueGroup",
        source: "api",
        detail: `tag=${clanTag}`,
        durationMs: Date.now() - startedAtMs,
        status: "success",
      });
      return data;
    } catch (err) {
      const status = (err as AxiosError)?.response?.status;
      const failure = toFailureTelemetry(err);
      if (status === 404) {
        recordFetchEvent({
          namespace: "coc",
          operation: "getClanWarLeagueGroup",
          source: "api",
          detail: `tag=${clanTag} status=404`,
          durationMs: Date.now() - startedAtMs,
          status: "failure",
          errorCategory: "validation",
          errorCode: "HTTP_404",
        });
        return null;
      }
      recordFetchEvent({
        namespace: "coc",
        operation: "getClanWarLeagueGroup",
        source: "api",
        detail: `tag=${clanTag} status=${status ?? "unknown"} result=error`,
        durationMs: Date.now() - startedAtMs,
        status: "failure",
        errorCategory: failure.errorCategory,
        errorCode: failure.errorCode,
        timeout: failure.timeout,
      });
      if (status) throw new Error(`CoC API error ${status}`);
      throw err;
    }
  }

  /** Purpose: get one clan war league war by war tag. */
  async getClanWarLeagueWar(warTag: string): Promise<ClanWar | null> {
    const normalizedWarTag = warTag.startsWith("#") ? warTag : `#${warTag}`;
    const startedAtMs = Date.now();
    try {
      const { data } = await this.runQueuedRequest({
        operation: "getClanWarLeagueWar",
        detail: `warTag=${normalizedWarTag}`,
        run: () => this.clansApi.getClanWarLeagueWar(normalizedWarTag),
      });
      recordFetchEvent({
        namespace: "coc",
        operation: "getClanWarLeagueWar",
        source: "api",
        detail: `warTag=${normalizedWarTag}`,
        durationMs: Date.now() - startedAtMs,
        status: "success",
      });
      return data;
    } catch (err) {
      const status = (err as AxiosError)?.response?.status;
      const failure = toFailureTelemetry(err);
      if (status === 404) {
        recordFetchEvent({
          namespace: "coc",
          operation: "getClanWarLeagueWar",
          source: "api",
          detail: `warTag=${normalizedWarTag} status=404`,
          durationMs: Date.now() - startedAtMs,
          status: "failure",
          errorCategory: "validation",
          errorCode: "HTTP_404",
        });
        return null;
      }
      recordFetchEvent({
        namespace: "coc",
        operation: "getClanWarLeagueWar",
        source: "api",
        detail: `warTag=${normalizedWarTag} status=${status ?? "unknown"} result=error`,
        durationMs: Date.now() - startedAtMs,
        status: "failure",
        errorCategory: failure.errorCategory,
        errorCode: failure.errorCode,
        timeout: failure.timeout,
      });
      if (status) throw new Error(`CoC API error ${status}`);
      throw err;
    }
  }

  async getPlayerRaw(
    tag: string | undefined,
    options?: { suppressTelemetry?: boolean }
  ): Promise<any> {
    if (!tag) return null;
    const playerTag = tag.startsWith("#") ? tag : `#${tag}`;
    const startedAtMs = Date.now();

    try {
      const { data } = await this.runQueuedRequest({
        operation: "getPlayerRaw",
        detail: `tag=${playerTag}`,
        run: () => this.playersApi.getPlayer(playerTag),
      });
      if (!options?.suppressTelemetry) {
        recordFetchEvent({
          namespace: "coc",
          operation: "getPlayerRaw",
          source: "api",
          detail: `tag=${playerTag}`,
          durationMs: Date.now() - startedAtMs,
          status: "success",
        });
      }
      return this.normalizePlayer(data);
    } catch (err) {
      const status = (err as AxiosError)?.response?.status;
      const failure = toFailureTelemetry(err);
      if (status === 404) {
        if (!options?.suppressTelemetry) {
          recordFetchEvent({
            namespace: "coc",
            operation: "getPlayerRaw",
            source: "api",
            detail: `tag=${playerTag} status=404`,
            durationMs: Date.now() - startedAtMs,
            status: "failure",
            errorCategory: "validation",
            errorCode: "HTTP_404",
          });
        }
        return null;
      }
      if (!options?.suppressTelemetry) {
        recordFetchEvent({
          namespace: "coc",
          operation: "getPlayerRaw",
          source: "api",
          detail: `tag=${playerTag} status=${status ?? "unknown"} result=error`,
          durationMs: Date.now() - startedAtMs,
          status: "failure",
          errorCategory: failure.errorCategory,
          errorCode: failure.errorCode,
          timeout: failure.timeout,
        });
      }
      if (status) throw new Error(`CoC API error ${status}`);
      throw err;
    }
  }

  /** Purpose: normalize player. */
  private normalizePlayer(player: Player): any {
    return {
      ...player,
      tag: player.tag ?? "",
      name: player.name ?? "Unknown",
      clan: {
        ...player.clan,
        tag: player.clan?.tag ?? "UNKNOWN",
      },
      trophies: player.trophies ?? 0,
      donations: player.donations ?? 0,
      warStars: player.warStars ?? 0,
      // API v1 exposes builder trophies as versusTrophies.
      builderBaseTrophies: player.versusTrophies ?? 0,
      // Not present in this schema; keep compat field for existing logic.
      clanCapitalContributions: 0,
    };
  }
}

export type ClanCapitalRaidSeasonMember = {
  tag?: string | null;
  attacks?: number | null;
};

export type ClanCapitalRaidSeason = {
  state?: string | null;
  startTime?: string | null;
  endTime?: string | null;
  members?: ClanCapitalRaidSeasonMember[];
};
