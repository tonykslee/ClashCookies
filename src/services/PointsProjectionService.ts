import axios from "axios";
import { CoCService } from "./CoCService";

const POINTS_BASE_URL = "https://points.fwafarm.com/clan?tag=";
const TIEBREAK_ORDER = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const POINTS_REQUEST_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://points.fwafarm.com/",
  Origin: "https://points.fwafarm.com",
};

type Snapshot = {
  tag: string;
  clanName: string | null;
  balance: number | null;
  effectiveSync: number | null;
  syncMode: "low" | "high" | null;
};

function normalizeTag(input: string): string {
  return input.trim().toUpperCase().replace(/^#/, "");
}

function buildPointsUrl(tag: string): string {
  const normalizedTag = normalizeTag(tag);
  const proxyBase = (process.env.POINTS_PROXY_URL ?? "").trim();
  if (!proxyBase) return `${POINTS_BASE_URL}${normalizedTag}`;
  const proxyUrl = new URL(proxyBase);
  proxyUrl.searchParams.set("tag", normalizedTag);
  return proxyUrl.toString();
}

function toPlainText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractPointBalance(html: string): number | null {
  const directMatch = html.match(/(?:Point Balance|Current Point Balance)\s*:\s*([+-]?\d+)/i);
  if (directMatch?.[1]) return Number(directMatch[1]);
  const plain = toPlainText(html);
  const textMatch = plain.match(/(?:Point Balance|Current Point Balance)\s*:\s*([+-]?\d+)/i);
  return textMatch?.[1] ? Number(textMatch[1]) : null;
}

function extractField(text: string, label: string): string | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(
    `${escaped}\\s*:\\s*(.+?)(?=\\s+[A-Za-z][A-Za-z0-9\\s]{1,40}:|$)`,
    "i"
  );
  const match = text.match(regex);
  return match?.[1] ? match[1].trim().slice(0, 120) : null;
}

function extractWinnerBoxText(html: string): string | null {
  const match = html.match(
    /<p[^>]*class=["'][^"']*winner-box[^"']*["'][^>]*>([\s\S]*?)<\/p>/i
  );
  return match?.[1] ? toPlainText(match[1]) : null;
}

function extractTopSectionText(html: string): string {
  const plain = toPlainText(html);
  const marker = plain.search(/Last Known War State\s*:/i);
  return marker < 0 ? plain : plain.slice(0, marker).trim();
}

function extractTagsFromText(text: string): string[] {
  const tags = new Set<string>();
  for (const m of text.matchAll(/#([0-9A-Z]{4,})/gi)) {
    if (m[1]) tags.add(normalizeTag(m[1]));
  }
  for (const m of text.matchAll(/\(\s*([0-9A-Z]{4,})\s*\)/gi)) {
    if (m[1]) tags.add(normalizeTag(m[1]));
  }
  return [...tags];
}

function extractSyncNumber(text: string): number | null {
  const match = text.match(/sync\s*#\s*(\d+)/i);
  return match?.[1] ? Number(match[1]) : null;
}

function getSyncMode(syncNumber: number | null): "low" | "high" | null {
  if (syncNumber === null) return null;
  return syncNumber % 2 === 0 ? "high" : "low";
}

function rankChar(ch: string): number {
  const idx = TIEBREAK_ORDER.indexOf(ch);
  return idx >= 0 ? idx : Number.MAX_SAFE_INTEGER;
}

function compareTagsForTiebreak(primaryTag: string, opponentTag: string): number {
  const a = normalizeTag(primaryTag);
  const b = normalizeTag(opponentTag);
  const maxLen = Math.max(a.length, b.length);
  for (let i = 0; i < maxLen; i += 1) {
    const ra = rankChar(a[i] ?? "");
    const rb = rankChar(b[i] ?? "");
    if (ra === rb) continue;
    return ra - rb;
  }
  return 0;
}

function formatPoints(value: number | null): string {
  if (value === null || Number.isNaN(value)) return "N/A";
  return Intl.NumberFormat("en-US").format(value);
}

export class PointsProjectionService {
  constructor(private readonly cocService: CoCService) {}

  async fetchSnapshot(tag: string): Promise<Snapshot> {
    const normalizedTag = normalizeTag(tag);
    const url = buildPointsUrl(normalizedTag);
    const response = await axios.get<string>(url, {
      timeout: 15000,
      responseType: "text",
      headers: POINTS_REQUEST_HEADERS,
      validateStatus: () => true,
    });
    if (response.status >= 400) {
      return {
        tag: normalizedTag,
        clanName: await this.cocService.getClanName(normalizedTag).catch(() => null),
        balance: null,
        effectiveSync: null,
        syncMode: null,
      };
    }

    const html = String(response.data ?? "");
    const topSection = extractTopSectionText(html);
    const plain = toPlainText(html);
    const winnerBoxText = extractWinnerBoxText(html);
    const winnerBoxTags = extractTagsFromText(topSection || winnerBoxText || "");
    const winnerBoxSync = extractSyncNumber(topSection || winnerBoxText || "");
    const winnerBoxHasTag = winnerBoxTags.includes(normalizedTag);
    const effectiveSync =
      winnerBoxSync === null ? null : winnerBoxHasTag ? winnerBoxSync : winnerBoxSync + 1;

    return {
      tag: normalizedTag,
      clanName:
        extractField(topSection, "Clan Name") ??
        extractField(plain, "Clan Name") ??
        (await this.cocService.getClanName(normalizedTag).catch(() => null)),
      balance: extractPointBalance(html),
      effectiveSync,
      syncMode: getSyncMode(effectiveSync),
    };
  }

  buildProjection(primary: Snapshot, opponent: Snapshot): string {
    const primaryName = primary.clanName ?? primary.tag;
    const opponentName = opponent.clanName ?? opponent.tag;
    const x = primary.balance ?? 0;
    const y = opponent.balance ?? 0;

    if (primary.balance === null || opponent.balance === null) {
      return "Projection unavailable (points fetch failed).";
    }
    if (x > y) return `${primaryName} should win by points (${x} > ${y})`;
    if (y > x) return `${primaryName} should lose by points (${y} > ${x})`;

    const mode = primary.syncMode ?? opponent.syncMode;
    if (!mode) return `Points tied (${x} = ${y}); sync not found for tiebreak.`;
    const cmp = compareTagsForTiebreak(primary.tag, opponent.tag);
    if (cmp === 0) return `Points tied (${x} = ${y}); tags identical for tiebreak ordering.`;
    const primaryWins = mode === "low" ? cmp < 0 : cmp > 0;
    return primaryWins
      ? `${primaryName} should win by tiebreak (${x} = ${y}, ${mode} sync)`
      : `${primaryName} should lose by tiebreak (${x} = ${y}, ${mode} sync)`;
  }

  formatBalanceLine(primary: Snapshot, opponent: Snapshot): string {
    return `${primary.clanName ?? primary.tag}: ${formatPoints(primary.balance)} | ${
      opponent.clanName ?? opponent.tag
    }: ${formatPoints(opponent.balance)}`;
  }
}

