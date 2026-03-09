import axios from "axios";
import { recordFetchEvent } from "../helper/fetchTelemetry";

export type FwaStatsWeightFetchStatus =
  | "ok"
  | "login_required"
  | "parse_error"
  | "http_error"
  | "timeout"
  | "network_error";

export type FwaStatsWeightAge = {
  clanTag: string;
  sourceUrl: string;
  ageText: string | null;
  ageDays: number | null;
  scrapedAt: Date;
  status: FwaStatsWeightFetchStatus;
  httpStatus: number | null;
  fromCache: boolean;
  error: string | null;
};

type WeightCacheEntry = {
  expiresAtMs: number;
  result: Omit<FwaStatsWeightAge, "fromCache">;
};

/** Purpose: normalize clan tags to canonical #UPPER format. */
function normalizeClanTag(input: string): string {
  const bare = String(input ?? "").trim().toUpperCase().replace(/^#/, "");
  return bare ? `#${bare}` : "";
}

/** Purpose: build the FWA Stats weight page URL for one clan. */
export function buildFwaWeightPageUrl(clanTag: string): string {
  const normalized = normalizeClanTag(clanTag);
  const bare = normalized.replace(/^#/, "");
  return `https://fwastats.com/Clan/${bare}/Weight`;
}

/** Purpose: detect login-gated FWA Stats HTML responses. */
export function isFwaStatsLoginPage(html: string): boolean {
  const normalized = String(html ?? "").toLowerCase();
  if (!normalized) return false;
  return (
    (normalized.includes("<title>login") && normalized.includes("fwa stats")) ||
    (normalized.includes("login") && normalized.includes("fwa stats") && normalized.includes("navbar-brand"))
  );
}

/** Purpose: extract weight age token from HTML content. */
export function extractWeightAgeToken(html: string): string | null {
  const normalized = String(html ?? "").replace(/\s+/g, " ");
  if (!normalized) return null;
  const match = normalized.match(/Clan weight submitted\s+(.+?)\s+ago\b/i);
  const raw = String(match?.[1] ?? "").trim();
  if (!raw) return null;
  return raw.replace(/[. ]+$/g, "").trim() || null;
}

/** Purpose: convert human-readable weight age token to day units for health scoring. */
export function parseWeightAgeDays(token: string | null | undefined): number | null {
  const normalized = String(token ?? "").trim().toLowerCase();
  if (!normalized) return null;

  const match = normalized.match(
    /(\d+(?:\.\d+)?)\s*(d|day|days|h|hr|hrs|hour|hours|m|min|mins|minute|minutes|w|wk|wks|week|weeks|mo|mon|month|months|y|yr|yrs|year|years)\b/
  );
  if (!match) return null;

  const value = Number(match[1]);
  const unit = String(match[2] ?? "").toLowerCase();
  if (!Number.isFinite(value) || value < 0) return null;
  if (unit === "d" || unit === "day" || unit === "days") return value;
  if (unit === "h" || unit === "hr" || unit === "hrs" || unit === "hour" || unit === "hours") {
    return value / 24;
  }
  if (unit === "m" || unit === "min" || unit === "mins" || unit === "minute" || unit === "minutes") {
    return value / (24 * 60);
  }
  if (unit === "w" || unit === "wk" || unit === "wks" || unit === "week" || unit === "weeks") {
    return value * 7;
  }
  if (unit === "mo" || unit === "mon" || unit === "month" || unit === "months") {
    return value * 30;
  }
  if (unit === "y" || unit === "yr" || unit === "yrs" || unit === "year" || unit === "years") {
    return value * 365;
  }
  return null;
}

/** Purpose: identify retryable status codes for transient upstream failures. */
function isTransientHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

/** Purpose: identify retryable axios/network exceptions. */
function isTransientNetworkError(error: unknown): boolean {
  const code = String((error as { code?: string } | null)?.code ?? "").toUpperCase();
  return (
    code === "ECONNABORTED" ||
    code === "ETIMEDOUT" ||
    code === "ECONNRESET" ||
    code === "EAI_AGAIN"
  );
}

/** Purpose: identify timeout-specific network exceptions for telemetry/error reporting. */
function isTimeoutError(error: unknown): boolean {
  const code = String((error as { code?: string } | null)?.code ?? "").toUpperCase();
  return code === "ECONNABORTED" || code === "ETIMEDOUT";
}

/** Purpose: decide which fetch statuses are safe to cache briefly. */
function isCacheableFetchStatus(status: FwaStatsWeightFetchStatus): boolean {
  return status === "ok" || status === "login_required" || status === "parse_error";
}

/** Purpose: scrape + cache FWA Stats weight submission ages for one or more clans. */
export class FwaStatsWeightService {
  private static readonly REQUEST_TIMEOUT_MS = 5_000;
  private static readonly CACHE_TTL_MS = 10 * 60 * 1000;
  private static readonly MAX_ATTEMPTS = 2;
  private static readonly BATCH_CONCURRENCY = 5;

  private readonly cache = new Map<string, WeightCacheEntry>();
  private readonly inFlight = new Map<string, Promise<FwaStatsWeightAge>>();

  /** Purpose: clear in-memory cache (tests/maintenance). */
  clearCache(): void {
    this.cache.clear();
    this.inFlight.clear();
  }

  /** Purpose: return one clan's latest weight-age fetch result. */
  async getWeightAge(clanTagInput: string): Promise<FwaStatsWeightAge> {
    const clanTag = normalizeClanTag(clanTagInput);
    const sourceUrl = buildFwaWeightPageUrl(clanTag);
    if (!clanTag) {
      return {
        clanTag: "",
        sourceUrl,
        ageText: null,
        ageDays: null,
        scrapedAt: new Date(),
        status: "parse_error",
        httpStatus: null,
        fromCache: false,
        error: "Invalid clan tag.",
      };
    }

    const now = Date.now();
    const cached = this.cache.get(clanTag);
    if (cached && cached.expiresAtMs > now) {
      recordFetchEvent({
        namespace: "fwastats_weight",
        operation: "weight_age_fetch",
        source: "cache_hit",
        detail: `tag=${clanTag}`,
      });
      return {
        ...cached.result,
        fromCache: true,
      };
    }

    recordFetchEvent({
      namespace: "fwastats_weight",
      operation: "weight_age_fetch",
      source: "cache_miss",
      detail: `tag=${clanTag}`,
    });

    const pending = this.inFlight.get(clanTag);
    if (pending) {
      const result = await pending;
      return { ...result, fromCache: false };
    }

    const load = this.fetchWeightAge(clanTag)
      .then((result) => {
        if (isCacheableFetchStatus(result.status)) {
          const { fromCache: _ignored, ...cacheable } = result;
          this.cache.set(clanTag, {
            expiresAtMs: Date.now() + FwaStatsWeightService.CACHE_TTL_MS,
            result: cacheable,
          });
        }
        return result;
      })
      .finally(() => {
        this.inFlight.delete(clanTag);
      });

    this.inFlight.set(clanTag, load);
    const result = await load;
    return { ...result, fromCache: false };
  }

  /** Purpose: return weight-age results for many clans with bounded concurrency. */
  async getWeightAges(clanTags: string[]): Promise<FwaStatsWeightAge[]> {
    const targets = clanTags.map((tag) => normalizeClanTag(tag)).filter(Boolean);
    if (targets.length === 0) return [];

    const output = new Array<FwaStatsWeightAge>(targets.length);
    let nextIndex = 0;
    const workers = Array.from(
      { length: Math.min(FwaStatsWeightService.BATCH_CONCURRENCY, targets.length) },
      async () => {
        while (nextIndex < targets.length) {
          const currentIndex = nextIndex;
          nextIndex += 1;
          output[currentIndex] = await this.getWeightAge(targets[currentIndex] ?? "");
        }
      }
    );
    await Promise.all(workers);
    return output;
  }

  /** Purpose: fetch one clan weight page and normalize a typed result payload. */
  private async fetchWeightAge(clanTag: string): Promise<FwaStatsWeightAge> {
    const sourceUrl = buildFwaWeightPageUrl(clanTag);
    const startedAtMs = Date.now();

    for (let attempt = 1; attempt <= FwaStatsWeightService.MAX_ATTEMPTS; attempt += 1) {
      try {
        const response = await axios.get<string>(sourceUrl, {
          timeout: FwaStatsWeightService.REQUEST_TIMEOUT_MS,
          responseType: "text",
          validateStatus: () => true,
          headers: { "User-Agent": "Mozilla/5.0" },
        });

        if (response.status >= 400) {
          if (
            attempt < FwaStatsWeightService.MAX_ATTEMPTS &&
            isTransientHttpStatus(response.status)
          ) {
            continue;
          }
          const result: FwaStatsWeightAge = {
            clanTag,
            sourceUrl,
            ageText: null,
            ageDays: null,
            scrapedAt: new Date(),
            status: "http_error",
            httpStatus: response.status,
            fromCache: false,
            error: `fwastats returned ${response.status}`,
          };
          recordFetchEvent({
            namespace: "fwastats_weight",
            operation: "weight_age_fetch",
            source: "web",
            status: "failure",
            errorCategory: "http",
            errorCode: String(response.status),
            detail: `tag=${clanTag} status=http_error http=${response.status}`,
            durationMs: Date.now() - startedAtMs,
          });
          return result;
        }

        const html = String(response.data ?? "");
        if (isFwaStatsLoginPage(html)) {
          const result: FwaStatsWeightAge = {
            clanTag,
            sourceUrl,
            ageText: null,
            ageDays: null,
            scrapedAt: new Date(),
            status: "login_required",
            httpStatus: response.status,
            fromCache: false,
            error: "FWA Stats returned a login page.",
          };
          recordFetchEvent({
            namespace: "fwastats_weight",
            operation: "weight_age_fetch",
            source: "web",
            status: "failure",
            errorCategory: "auth",
            errorCode: "login_required",
            detail: `tag=${clanTag} status=login_required`,
            durationMs: Date.now() - startedAtMs,
          });
          return result;
        }

        const token = extractWeightAgeToken(html);
        if (!token) {
          const result: FwaStatsWeightAge = {
            clanTag,
            sourceUrl,
            ageText: null,
            ageDays: null,
            scrapedAt: new Date(),
            status: "parse_error",
            httpStatus: response.status,
            fromCache: false,
            error: "Could not find 'Clan weight submitted ... ago' in page HTML.",
          };
          recordFetchEvent({
            namespace: "fwastats_weight",
            operation: "weight_age_fetch",
            source: "web",
            status: "failure",
            errorCategory: "parse",
            errorCode: "weight_age_not_found",
            detail: `tag=${clanTag} status=parse_error`,
            durationMs: Date.now() - startedAtMs,
          });
          return result;
        }

        const result: FwaStatsWeightAge = {
          clanTag,
          sourceUrl,
          ageText: `${token} ago`,
          ageDays: parseWeightAgeDays(token),
          scrapedAt: new Date(),
          status: "ok",
          httpStatus: response.status,
          fromCache: false,
          error: null,
        };
        recordFetchEvent({
          namespace: "fwastats_weight",
          operation: "weight_age_fetch",
          source: "web",
          status: "success",
          detail: `tag=${clanTag} status=ok age=${result.ageText ?? "unknown"} cache=miss`,
          durationMs: Date.now() - startedAtMs,
        });
        return result;
      } catch (error) {
        const timeout = isTimeoutError(error);
        if (attempt < FwaStatsWeightService.MAX_ATTEMPTS && isTransientNetworkError(error)) {
          continue;
        }
        const status: FwaStatsWeightFetchStatus = timeout ? "timeout" : "network_error";
        const result: FwaStatsWeightAge = {
          clanTag,
          sourceUrl,
          ageText: null,
          ageDays: null,
          scrapedAt: new Date(),
          status,
          httpStatus: null,
          fromCache: false,
          error: String((error as { message?: string } | null)?.message ?? "Network failure."),
        };
        recordFetchEvent({
          namespace: "fwastats_weight",
          operation: "weight_age_fetch",
          source: "web",
          status: "failure",
          errorCategory: "network",
          errorCode: status,
          timeout,
          detail: `tag=${clanTag} status=${status}`,
          durationMs: Date.now() - startedAtMs,
        });
        return result;
      }
    }

    return {
      clanTag,
      sourceUrl,
      ageText: null,
      ageDays: null,
      scrapedAt: new Date(),
      status: "network_error",
      httpStatus: null,
      fromCache: false,
      error: "Unknown fetch failure.",
    };
  }
}
