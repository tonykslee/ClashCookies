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

type ApplicationEmojiFetchOwner = {
  emojis?: {
    fetch?: () => Promise<Map<string, any> | { values: () => Iterable<any> }>;
  };
};

const SHORTCODE_REPLACE_PATTERN =
  /(^|[\s([{"']):([a-zA-Z0-9_]{2,32}):(?=$|[\s)\]}".,!?:;'"-])/g;

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

/** Purpose: resolve bot-owned application emojis by name and replace shortcode text safely. */
export class EmojiResolverService {
  private snapshot: EmojiSnapshot | null = null;

  /** Purpose: configure refreshable in-memory cache TTL for resolver lookups. */
  constructor(private readonly cacheTtlMs: number = 30_000) {}

  /** Purpose: force-refresh the application emoji snapshot from Discord. */
  async refresh(client: Client): Promise<void> {
    this.snapshot = await this.fetchSnapshot(client);
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
    const nowMs = Date.now();
    if (
      !forceRefresh &&
      this.snapshot &&
      nowMs - this.snapshot.fetchedAtMs <= this.cacheTtlMs
    ) {
      return this.snapshot;
    }
    const next = await this.fetchSnapshot(client);
    this.snapshot = next;
    return next;
  }

  /** Purpose: safely ensure client application hydration before reading application emoji inventory. */
  private async ensureApplication(client: Client) {
    if (client.application) {
      await client.application.fetch().catch(() => undefined);
      return client.application;
    }
    return null;
  }

  /** Purpose: build a fresh application-emoji snapshot keyed for exact and case-insensitive lookups. */
  private async fetchSnapshot(client: Client): Promise<EmojiSnapshot> {
    const application = await this.ensureApplication(client);
    if (!application) {
      return {
        fetchedAtMs: Date.now(),
        entries: [],
        exactByName: new Map<string, ResolvedApplicationEmoji>(),
        lowercaseByName: new Map<string, ResolvedApplicationEmoji>(),
      };
    }

    const applicationWithEmojis = application as unknown as ApplicationEmojiFetchOwner;
    const emojiFetch = applicationWithEmojis.emojis?.fetch;
    if (typeof emojiFetch !== "function") {
      return {
        fetchedAtMs: Date.now(),
        entries: [],
        exactByName: new Map<string, ResolvedApplicationEmoji>(),
        lowercaseByName: new Map<string, ResolvedApplicationEmoji>(),
      };
    }

    const fetched = await emojiFetch();
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
      fetchedAtMs: Date.now(),
      entries,
      exactByName,
      lowercaseByName,
    };
  }
}

export const emojiResolverService = new EmojiResolverService();
