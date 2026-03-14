import { SettingsService } from "./SettingsService";

const FWASTATS_WEIGHT_COOKIE_SETTING_KEY = "fwastats_weight_cookie_v1";
const DEFAULT_APP_COOKIE_NAME = ".AspNetCore.Identity.Application";
const DEFAULT_ANTIFORGERY_COOKIE_NAME = ".AspNetCore.Antiforgery.oBHtDLr47-0";
const SETTINGS_CACHE_TTL_MS = 30 * 1000;

export type FwaStatsWeightAuthErrorCode =
  | "FWASTATS_AUTH_REQUIRED"
  | "FWASTATS_AUTH_EXPIRED"
  | "FWASTATS_LOGIN_PAGE_DETECTED";

type StoredCookie = {
  name: string;
  value: string;
  expiresAtIso: string | null;
  updatedAtIso: string;
};

type StoredWeightCookieConfig = {
  version: 1;
  updatedAtIso: string;
  updatedByGuildId: string | null;
  updatedByUserId: string | null;
  applicationCookie: StoredCookie | null;
  antiforgeryCookie: StoredCookie | null;
};

type ParsedCookieInput = {
  name: string | null;
  value: string;
  expiresAt: Date | null;
  hadExplicitName: boolean;
};

type CookieHeaderContext = {
  cookieHeader: string | null;
  source: "settings" | "env" | "none";
};

export type FwaStatsWeightCookieStatus = {
  applicationCookiePresent: boolean;
  antiforgeryCookiePresent: boolean;
  applicationCookieExpiresAt: Date | null;
  updatedAt: Date | null;
  runtimeCookieSource: "settings" | "env" | "none";
};

const EMPTY_STATUS: FwaStatsWeightCookieStatus = {
  applicationCookiePresent: false,
  antiforgeryCookiePresent: false,
  applicationCookieExpiresAt: null,
  updatedAt: null,
  runtimeCookieSource: "none",
};

/** Purpose: normalize dates and drop invalid values safely. */
function normalizeDate(input: Date | null): Date | null {
  if (!(input instanceof Date)) return null;
  return Number.isFinite(input.getTime()) ? input : null;
}

/** Purpose: parse optional ISO date strings from persisted config safely. */
function parseOptionalIsoDate(input: string | null | undefined): Date | null {
  if (!input) return null;
  const parsed = new Date(input);
  return normalizeDate(parsed);
}

/** Purpose: parse one cookie token, preserving name/value and optional expiry metadata. */
function parseCookieInput(
  rawInput: string
): { ok: true; value: ParsedCookieInput } | { ok: false; error: string } {
  const normalizedInput = String(rawInput ?? "").trim();
  if (!normalizedInput) {
    return { ok: false, error: "Cookie value cannot be empty." };
  }

  const withoutPrefix = normalizedInput.replace(/^cookie:\s*/i, "").trim();
  if (!withoutPrefix) {
    return { ok: false, error: "Cookie value cannot be empty." };
  }

  const segments = withoutPrefix
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
  if (segments.length <= 0) {
    return { ok: false, error: "Cookie format is invalid." };
  }

  const firstSegment = segments[0] ?? "";
  const pairSeparatorIndex = firstSegment.indexOf("=");
  const candidateName = pairSeparatorIndex >= 0 ? firstSegment.slice(0, pairSeparatorIndex).trim() : "";
  const candidateValue = pairSeparatorIndex >= 0 ? firstSegment.slice(pairSeparatorIndex + 1).trim() : "";
  const treatAsExplicitPair =
    pairSeparatorIndex >= 0 &&
    Boolean(candidateName) &&
    isValidCookieName(candidateName) &&
    Boolean(candidateValue);
  const parsedName = treatAsExplicitPair ? candidateName : null;
  const parsedValue = treatAsExplicitPair ? candidateValue : firstSegment.trim();
  if (!parsedValue) {
    return { ok: false, error: "Cookie value cannot be empty." };
  }

  let expiresAt: Date | null = null;
  const nowMs = Date.now();
  for (const rawSegment of segments.slice(1)) {
    const lower = rawSegment.toLowerCase();
    if (lower.startsWith("expires=")) {
      const value = rawSegment.slice("expires=".length).trim();
      const parsed = normalizeDate(new Date(value));
      if (parsed) {
        expiresAt = parsed;
      }
      continue;
    }
    if (lower.startsWith("max-age=")) {
      const seconds = Number(rawSegment.slice("max-age=".length).trim());
      if (Number.isFinite(seconds)) {
        expiresAt = new Date(nowMs + Math.max(0, Math.trunc(seconds)) * 1000);
      }
    }
  }

  return {
    ok: true,
    value: {
      name: parsedName,
      value: parsedValue,
      expiresAt,
      hadExplicitName: pairSeparatorIndex >= 0 && Boolean(parsedName),
    },
  };
}

/** Purpose: validate cookie-name safety and reject malformed option values early. */
function isValidCookieName(input: string): boolean {
  const value = String(input ?? "").trim();
  return /^[A-Za-z0-9._-]+$/.test(value);
}

/** Purpose: serialize one parsed cookie into persisted representation. */
function toStoredCookie(input: ParsedCookieInput, updatedAt: Date): StoredCookie {
  return {
    name: input.name ?? "",
    value: input.value,
    expiresAtIso: input.expiresAt ? input.expiresAt.toISOString() : null,
    updatedAtIso: updatedAt.toISOString(),
  };
}

/** Purpose: normalize cookie names for safe display/logging without exposing values. */
function displayCookieName(name: string): string {
  const normalized = String(name ?? "").trim();
  return normalized || "unknown_cookie";
}

/** Purpose: safely compose a Cookie header from two persisted cookie pairs. */
function buildCookieHeaderFromStoredConfig(config: StoredWeightCookieConfig): string | null {
  const app = config.applicationCookie;
  const anti = config.antiforgeryCookie;
  if (!app?.name || !app.value || !anti?.name || !anti.value) return null;
  return `${app.name}=${app.value}; ${anti.name}=${anti.value}`;
}

/** Purpose: persist and resolve fwastats weight cookies through the existing SettingsService pattern. */
export class FwaStatsWeightCookieService {
  private cacheExpiresAtMs = 0;
  private cachedConfig: StoredWeightCookieConfig | null = null;

  /** Purpose: initialize service dependencies. */
  constructor(private readonly settings = new SettingsService()) {}

  /** Purpose: clear in-memory settings cache (tests / immediate refresh paths). */
  clearCache(): void {
    this.cacheExpiresAtMs = 0;
    this.cachedConfig = null;
  }

  /** Purpose: set both required fwastats cookie pairs using secret-safe persisted config. */
  async setCookies(params: {
    applicationCookieRaw: string;
    antiforgeryCookieRaw: string;
    antiforgeryCookieNameRaw?: string | null;
    guildId: string | null;
    userId: string | null;
  }): Promise<{
    savedAt: Date;
    applicationCookieName: string;
    antiforgeryCookieName: string;
    applicationCookieExpiresAt: Date | null;
  }> {
    const appParsed = parseCookieInput(params.applicationCookieRaw);
    if (!appParsed.ok) {
      throw new Error(`Application cookie invalid: ${appParsed.error}`);
    }
    const antiParsed = parseCookieInput(params.antiforgeryCookieRaw);
    if (!antiParsed.ok) {
      throw new Error(`Antiforgery cookie invalid: ${antiParsed.error}`);
    }
    const explicitAntiforgeryName = String(params.antiforgeryCookieNameRaw ?? "").trim();
    if (explicitAntiforgeryName && !isValidCookieName(explicitAntiforgeryName)) {
      throw new Error(
        "Antiforgery cookie invalid: Cookie name must use letters, digits, `.`, `_`, or `-`."
      );
    }

    const applicationCookie: ParsedCookieInput = {
      name: DEFAULT_APP_COOKIE_NAME,
      value: appParsed.value.value,
      expiresAt: appParsed.value.expiresAt,
      hadExplicitName: true,
    };
    const resolvedAntiforgeryName =
      explicitAntiforgeryName ||
      (antiParsed.value.hadExplicitName && antiParsed.value.name ? antiParsed.value.name : null) ||
      DEFAULT_ANTIFORGERY_COOKIE_NAME;
    const antiforgeryCookie: ParsedCookieInput = {
      name: resolvedAntiforgeryName,
      value: antiParsed.value.value,
      expiresAt: antiParsed.value.expiresAt,
      hadExplicitName: true,
    };

    const savedAt = new Date();
    const payload: StoredWeightCookieConfig = {
      version: 1,
      updatedAtIso: savedAt.toISOString(),
      updatedByGuildId: params.guildId ?? null,
      updatedByUserId: params.userId ?? null,
      applicationCookie: toStoredCookie(applicationCookie, savedAt),
      antiforgeryCookie: toStoredCookie(antiforgeryCookie, savedAt),
    };
    await this.settings.set(FWASTATS_WEIGHT_COOKIE_SETTING_KEY, JSON.stringify(payload));
    this.cachedConfig = payload;
    this.cacheExpiresAtMs = Date.now() + SETTINGS_CACHE_TTL_MS;
    return {
      savedAt,
      applicationCookieName: displayCookieName(applicationCookie.name ?? ""),
      antiforgeryCookieName: displayCookieName(antiforgeryCookie.name ?? ""),
      applicationCookieExpiresAt: applicationCookie.expiresAt,
    };
  }

  /** Purpose: return secret-safe cookie status details for operator-facing status checks. */
  async getCookieStatus(): Promise<FwaStatsWeightCookieStatus> {
    const config = await this.getStoredConfig();
    const runtime = await this.getCookieHeaderContext();
    if (!config) {
      return {
        ...EMPTY_STATUS,
        runtimeCookieSource: runtime.source,
      };
    }

    return {
      applicationCookiePresent: Boolean(config.applicationCookie?.name && config.applicationCookie?.value),
      antiforgeryCookiePresent: Boolean(config.antiforgeryCookie?.name && config.antiforgeryCookie?.value),
      applicationCookieExpiresAt: parseOptionalIsoDate(config.applicationCookie?.expiresAtIso),
      updatedAt: parseOptionalIsoDate(config.updatedAtIso),
      runtimeCookieSource: runtime.source,
    };
  }

  /** Purpose: return cookie header and source for fwastats authenticated fetches. */
  async getCookieHeaderContext(): Promise<CookieHeaderContext> {
    const stored = await this.getStoredConfig();
    if (stored) {
      const header = buildCookieHeaderFromStoredConfig(stored);
      if (header) {
        return { cookieHeader: header, source: "settings" };
      }
    }

    const envCookie = String(process.env.FWASTATS_WEIGHT_COOKIE ?? "").trim();
    if (envCookie) {
      return {
        cookieHeader: envCookie,
        source: "env",
      };
    }

    return {
      cookieHeader: null,
      source: "none",
    };
  }

  /** Purpose: load and parse persisted weight-cookie config with short-lived memoization. */
  private async getStoredConfig(): Promise<StoredWeightCookieConfig | null> {
    const nowMs = Date.now();
    if (this.cachedConfig && this.cacheExpiresAtMs > nowMs) {
      return this.cachedConfig;
    }
    const raw = await this.settings.get(FWASTATS_WEIGHT_COOKIE_SETTING_KEY);
    if (!raw) {
      this.cachedConfig = null;
      this.cacheExpiresAtMs = nowMs + SETTINGS_CACHE_TTL_MS;
      return null;
    }

    try {
      const parsed = JSON.parse(raw) as Partial<StoredWeightCookieConfig> | null;
      if (!parsed || typeof parsed !== "object") {
        this.cachedConfig = null;
        this.cacheExpiresAtMs = nowMs + SETTINGS_CACHE_TTL_MS;
        return null;
      }
      const normalized: StoredWeightCookieConfig = {
        version: 1,
        updatedAtIso:
          typeof parsed.updatedAtIso === "string" && parsed.updatedAtIso
            ? parsed.updatedAtIso
            : new Date(0).toISOString(),
        updatedByGuildId:
          typeof parsed.updatedByGuildId === "string" && parsed.updatedByGuildId
            ? parsed.updatedByGuildId
            : null,
        updatedByUserId:
          typeof parsed.updatedByUserId === "string" && parsed.updatedByUserId
            ? parsed.updatedByUserId
            : null,
        applicationCookie:
          parsed.applicationCookie &&
          typeof parsed.applicationCookie === "object" &&
          typeof parsed.applicationCookie.name === "string" &&
          typeof parsed.applicationCookie.value === "string"
            ? {
                name: parsed.applicationCookie.name,
                value: parsed.applicationCookie.value,
                expiresAtIso:
                  typeof parsed.applicationCookie.expiresAtIso === "string"
                    ? parsed.applicationCookie.expiresAtIso
                    : null,
                updatedAtIso:
                  typeof parsed.applicationCookie.updatedAtIso === "string"
                    ? parsed.applicationCookie.updatedAtIso
                    : new Date(0).toISOString(),
              }
            : null,
        antiforgeryCookie:
          parsed.antiforgeryCookie &&
          typeof parsed.antiforgeryCookie === "object" &&
          typeof parsed.antiforgeryCookie.name === "string" &&
          typeof parsed.antiforgeryCookie.value === "string"
            ? {
                name: parsed.antiforgeryCookie.name,
                value: parsed.antiforgeryCookie.value,
                expiresAtIso:
                  typeof parsed.antiforgeryCookie.expiresAtIso === "string"
                    ? parsed.antiforgeryCookie.expiresAtIso
                    : null,
                updatedAtIso:
                  typeof parsed.antiforgeryCookie.updatedAtIso === "string"
                    ? parsed.antiforgeryCookie.updatedAtIso
                    : new Date(0).toISOString(),
              }
            : null,
      };
      this.cachedConfig = normalized;
      this.cacheExpiresAtMs = nowMs + SETTINGS_CACHE_TTL_MS;
      return normalized;
    } catch {
      this.cachedConfig = null;
      this.cacheExpiresAtMs = nowMs + SETTINGS_CACHE_TTL_MS;
      return null;
    }
  }
}

