import { Client } from "discord.js";

export type ResolvedApplicationEmoji = {
  id: string;
  name: string;
  shortcode: string;
  rendered: string;
  animated: boolean;
};

type EmojiSnapshot = {
  fetchedAtMs: number;
  entries: ResolvedApplicationEmoji[];
  exactByName: Map<string, ResolvedApplicationEmoji>;
  lowercaseByName: Map<string, ResolvedApplicationEmoji>;
};

type ParsedCustomEmojiToken = {
  animated: boolean;
  name: string;
  id: string;
};

export type EmojiInputSourceType =
  | "custom_emoji_token"
  | "direct_image_url"
  | "unicode_emoji_unsupported"
  | "invalid_input";

export type ParsedEmojiImageSourceSuccess = {
  ok: true;
  sourceType: "custom_emoji_token" | "direct_image_url";
  imageUrl: string;
  customEmojiId: string | null;
  animated: boolean;
};

export type ParsedEmojiImageSourceFailure = {
  ok: false;
  sourceType: "unicode_emoji_unsupported" | "invalid_input";
  code: "unsupported_unicode_emoji" | "invalid_emoji_input";
};

export type ParsedEmojiImageSourceResult =
  | ParsedEmojiImageSourceSuccess
  | ParsedEmojiImageSourceFailure;

export type EmojiResolverFailureCode =
  | "application_missing"
  | "application_fetch_failed"
  | "application_emoji_manager_unavailable"
  | "application_emoji_fetch_failed";

export type EmojiResolverDiagnostics = {
  applicationExistedBeforeFetch: boolean;
  applicationFetchAttempted: boolean;
  applicationEmojiFetchAvailable: boolean;
  emojiFetchSucceeded: boolean;
  fetchedEmojiCount: number;
};

export type EmojiInventoryFetchSuccess = {
  ok: true;
  snapshot: EmojiSnapshot;
  diagnostics: EmojiResolverDiagnostics;
};

export type EmojiInventoryFetchFailure = {
  ok: false;
  code: EmojiResolverFailureCode;
  diagnostics: EmojiResolverDiagnostics;
  cause?: unknown;
};

export type EmojiInventoryFetchResult =
  | EmojiInventoryFetchSuccess
  | EmojiInventoryFetchFailure;

type EnsureApplicationResult =
  | {
      ok: true;
      application: NonNullable<Client["application"]>;
    }
  | EmojiInventoryFetchFailure;

const SHORTCODE_REPLACE_PATTERN =
  /(^|[\s([{"']):([a-zA-Z0-9_]{2,32}):(?=$|[\s)\]}".,!?:;'"-])/g;
const CUSTOM_EMOJI_TOKEN_PATTERN = /^<(a?):([a-zA-Z0-9_]{2,32}):(\d{17,22})>$/;
const SHORTCODE_NAME_PATTERN = /^[a-zA-Z0-9_]{2,32}$/;
const UNICODE_EMOJI_PATTERN = /[\p{Extended_Pictographic}\uFE0F]/u;

/** Purpose: trim and de-colon one shortcode name for canonical application emoji creation lookup. */
export function normalizeEmojiShortcodeName(input: string): string {
  const trimmed = String(input ?? "").trim();
  if (!trimmed) return "";
  const withoutColons = trimmed.replace(/^:+/, "").replace(/:+$/, "");
  return withoutColons.trim();
}

/** Purpose: validate one normalized application emoji shortcode name against Discord naming constraints. */
export function isValidEmojiShortcodeName(input: string): boolean {
  return SHORTCODE_NAME_PATTERN.test(String(input ?? ""));
}

/** Purpose: parse one custom Discord emoji token into id/name/animated fields for CDN source resolution. */
function parseCustomEmojiToken(input: string): ParsedCustomEmojiToken | null {
  const match = input.match(CUSTOM_EMOJI_TOKEN_PATTERN);
  if (!match) return null;
  return {
    animated: match[1] === "a",
    name: match[2],
    id: match[3],
  };
}

/** Purpose: test whether one arbitrary input likely contains a unicode emoji that this patch does not rasterize. */
function looksLikeUnicodeEmoji(input: string): boolean {
  return UNICODE_EMOJI_PATTERN.test(input);
}

/** Purpose: parse user-provided emoji image input into a canonical application-emoji upload source. */
export function parseEmojiImageSource(
  input: string,
): ParsedEmojiImageSourceResult {
  const trimmed = String(input ?? "").trim();
  if (!trimmed) {
    return {
      ok: false,
      sourceType: "invalid_input",
      code: "invalid_emoji_input",
    };
  }

  const parsedToken = parseCustomEmojiToken(trimmed);
  if (parsedToken) {
    const ext = parsedToken.animated ? "gif" : "png";
    return {
      ok: true,
      sourceType: "custom_emoji_token",
      imageUrl: `https://cdn.discordapp.com/emojis/${parsedToken.id}.${ext}?quality=lossless`,
      customEmojiId: parsedToken.id,
      animated: parsedToken.animated,
    };
  }

  try {
    const url = new URL(trimmed);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return {
        ok: true,
        sourceType: "direct_image_url",
        imageUrl: url.toString(),
        customEmojiId: null,
        animated: false,
      };
    }
  } catch {
    // Ignore URL parse errors and fall through to deterministic input classification.
  }

  if (looksLikeUnicodeEmoji(trimmed)) {
    return {
      ok: false,
      sourceType: "unicode_emoji_unsupported",
      code: "unsupported_unicode_emoji",
    };
  }

  return {
    ok: false,
    sourceType: "invalid_input",
    code: "invalid_emoji_input",
  };
}

/** Purpose: normalize user-provided emoji-name input while preserving name-based environment stability. */
export function normalizeEmojiLookupName(input: string): string {
  const trimmed = String(input ?? "").trim();
  if (!trimmed) return "";
  const inner = trimmed.replace(/^:/, "").replace(/:$/, "");
  return inner.trim();
}

/** Purpose: sort emoji entries deterministically for stable command output across runs. */
function sortResolvedEmojis(
  values: ResolvedApplicationEmoji[],
): ResolvedApplicationEmoji[] {
  return [...values].sort((a, b) => {
    const byLower = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    if (byLower !== 0) return byLower;
    const byExact = a.name.localeCompare(b.name);
    if (byExact !== 0) return byExact;
    return a.id.localeCompare(b.id);
  });
}

/** Purpose: represent resolver fetch failures with explicit reason codes and diagnostics. */
export class EmojiResolverRuntimeError extends Error {
  readonly code: EmojiResolverFailureCode;
  readonly diagnostics: EmojiResolverDiagnostics;
  readonly cause?: unknown;

  constructor(params: {
    code: EmojiResolverFailureCode;
    diagnostics: EmojiResolverDiagnostics;
    cause?: unknown;
  }) {
    super(`Emoji resolver failed: ${params.code}`);
    this.name = "EmojiResolverRuntimeError";
    this.code = params.code;
    this.diagnostics = params.diagnostics;
    this.cause = params.cause;
  }
}

/** Purpose: create default diagnostics for one snapshot fetch attempt. */
function createEmptyDiagnostics(
  applicationExistedBeforeFetch: boolean,
): EmojiResolverDiagnostics {
  return {
    applicationExistedBeforeFetch,
    applicationFetchAttempted: false,
    applicationEmojiFetchAvailable: false,
    emojiFetchSucceeded: false,
    fetchedEmojiCount: 0,
  };
}

/** Purpose: resolve bot-owned application emojis by name and replace shortcode text safely. */
export class EmojiResolverService {
  private snapshot: EmojiSnapshot | null = null;

  /** Purpose: configure refreshable in-memory cache TTL for resolver lookups. */
  constructor(private readonly cacheTtlMs: number = 30_000) {}

  /** Purpose: fetch application-emoji inventory with explicit success/failure typing for command-level handling. */
  async fetchApplicationEmojiInventory(
    client: Client,
    options?: { forceRefresh?: boolean },
  ): Promise<EmojiInventoryFetchResult> {
    return this.getSnapshotResult(client, options?.forceRefresh ?? false);
  }

  /** Purpose: force-refresh the application emoji snapshot from Discord. */
  async refresh(client: Client): Promise<void> {
    const result = await this.fetchApplicationEmojiInventory(client, {
      forceRefresh: true,
    });
    if (!result.ok) {
      throw this.toRuntimeError(result);
    }
    this.snapshot = result.snapshot;
  }

  /** Purpose: invalidate in-memory emoji snapshot cache so subsequent reads refetch current application state. */
  invalidateCache(): void {
    this.snapshot = null;
  }

  /** Purpose: resolve one emoji by name (case-insensitive) from bot application emojis. */
  async resolveByName(
    client: Client,
    name: string,
    options?: { forceRefresh?: boolean },
  ): Promise<ResolvedApplicationEmoji | null> {
    const normalizedName = normalizeEmojiLookupName(name);
    if (!normalizedName) return null;
    const snapshot = await this.getSnapshot(client, options?.forceRefresh ?? false);
    return (
      snapshot.exactByName.get(normalizedName) ??
      snapshot.lowercaseByName.get(normalizedName.toLowerCase()) ??
      null
    );
  }

  /** Purpose: replace valid `:emoji_name:` shortcodes with application emoji render tokens. */
  async replaceShortcodes(
    client: Client,
    text: string,
    options?: { forceRefresh?: boolean },
  ): Promise<string> {
    const source = String(text ?? "");
    if (!source.includes(":")) return source;
    const snapshot = await this.getSnapshot(client, options?.forceRefresh ?? false);
    if (snapshot.entries.length === 0) return source;
    return source.replace(
      SHORTCODE_REPLACE_PATTERN,
      (full, prefix: string, emojiName: string) => {
        const resolved =
          snapshot.exactByName.get(emojiName) ??
          snapshot.lowercaseByName.get(emojiName.toLowerCase());
        if (!resolved) return full;
        return `${prefix}${resolved.rendered}`;
      },
    );
  }

  /** Purpose: list all available bot application emojis in deterministic order. */
  async listApplicationEmojis(
    client: Client,
    options?: { forceRefresh?: boolean },
  ): Promise<ResolvedApplicationEmoji[]> {
    const snapshot = await this.getSnapshot(client, options?.forceRefresh ?? false);
    return [...snapshot.entries];
  }

  /** Purpose: fetch cached snapshot when fresh, otherwise rebuild from current bot application emojis. */
  private async getSnapshot(
    client: Client,
    forceRefresh: boolean,
  ): Promise<EmojiSnapshot> {
    const result = await this.getSnapshotResult(client, forceRefresh);
    if (!result.ok) {
      throw this.toRuntimeError(result);
    }
    return result.snapshot;
  }

  /** Purpose: return a typed snapshot result while honoring cache freshness for repeat lookups. */
  private async getSnapshotResult(
    client: Client,
    forceRefresh: boolean,
  ): Promise<EmojiInventoryFetchResult> {
    const nowMs = Date.now();
    if (
      !forceRefresh &&
      this.snapshot &&
      nowMs - this.snapshot.fetchedAtMs <= this.cacheTtlMs
    ) {
      return {
        ok: true,
        snapshot: this.snapshot,
        diagnostics: {
          applicationExistedBeforeFetch: Boolean(client.application),
          applicationFetchAttempted: false,
          applicationEmojiFetchAvailable: true,
          emojiFetchSucceeded: true,
          fetchedEmojiCount: this.snapshot.entries.length,
        },
      };
    }
    const next = await this.fetchSnapshot(client);
    if (next.ok) {
      this.snapshot = next.snapshot;
    }
    return next;
  }

  /** Purpose: safely ensure client application hydration before reading application emoji inventory. */
  private async ensureApplication(
    client: Client,
    diagnostics: EmojiResolverDiagnostics,
  ): Promise<EnsureApplicationResult> {
    if (!client.application) {
      return {
        ok: false,
        code: "application_missing",
        diagnostics,
      };
    }
    diagnostics.applicationFetchAttempted = true;
    try {
      await client.application.fetch();
    } catch (error) {
      return {
        ok: false,
        code: "application_fetch_failed",
        diagnostics,
        cause: error,
      };
    }
    if (!client.application) {
      return {
        ok: false,
        code: "application_missing",
        diagnostics,
      };
    }
    return {
      ok: true,
      application: client.application,
    };
  }

  /** Purpose: build a fresh application-emoji snapshot keyed for exact and case-insensitive lookups. */
  private async fetchSnapshot(client: Client): Promise<EmojiInventoryFetchResult> {
    const diagnostics = createEmptyDiagnostics(Boolean(client.application));
    const applicationResult = await this.ensureApplication(client, diagnostics);
    if (!applicationResult.ok) {
      return applicationResult;
    }
    const application = applicationResult.application;

    if (!application?.emojis || typeof application.emojis.fetch !== "function") {
      return {
        ok: false,
        code: "application_emoji_manager_unavailable",
        diagnostics,
      };
    }
    diagnostics.applicationEmojiFetchAvailable = true;

    let fetched;
    try {
      fetched = await application.emojis.fetch();
    } catch (error) {
      return {
        ok: false,
        code: "application_emoji_fetch_failed",
        diagnostics,
        cause: error,
      };
    }
    diagnostics.emojiFetchSucceeded = true;

    const collected: ResolvedApplicationEmoji[] = [];
    for (const emoji of fetched.values()) {
      const name = String(emoji.name ?? "").trim();
      const rendered = String(emoji.toString?.() ?? "").trim();
      if (!name || !rendered) continue;
      collected.push({
        id: String(emoji.id),
        name,
        shortcode: `:${name}:`,
        rendered,
        animated: Boolean(emoji.animated),
      });
    }
    diagnostics.fetchedEmojiCount = collected.length;

    const entries = sortResolvedEmojis(collected);
    const exactByName = new Map<string, ResolvedApplicationEmoji>();
    const lowercaseByName = new Map<string, ResolvedApplicationEmoji>();
    for (const entry of entries) {
      if (!exactByName.has(entry.name)) {
        exactByName.set(entry.name, entry);
      }
      const lowered = entry.name.toLowerCase();
      if (!lowercaseByName.has(lowered)) {
        lowercaseByName.set(lowered, entry);
      }
    }

    return {
      ok: true,
      diagnostics,
      snapshot: {
        fetchedAtMs: Date.now(),
        entries,
        exactByName,
        lowercaseByName,
      },
    };
  }

  /** Purpose: normalize typed failure results into thrown errors for legacy call sites. */
  private toRuntimeError(failure: EmojiInventoryFetchFailure): EmojiResolverRuntimeError {
    return new EmojiResolverRuntimeError({
      code: failure.code,
      diagnostics: failure.diagnostics,
      cause: failure.cause,
    });
  }
}

export const emojiResolverService = new EmojiResolverService();
