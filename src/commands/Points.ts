import axios from "axios";
import {
  ApplicationCommandOptionType,
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  Client,
} from "discord.js";
import { Command } from "../Command";
import { formatError } from "../helper/formatError";
import { safeReply } from "../helper/safeReply";
import { prisma } from "../prisma";
import { CoCService } from "../services/CoCService";

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

function normalizeTag(input: string): string {
  return input.trim().toUpperCase().replace(/^#/, "");
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

function extractField(text: string, label: string): string | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`${escaped}\\s*:\\s*([^\\n\\r]+)`, "i");
  const match = text.match(regex);
  if (!match?.[1]) return null;
  return match[1].trim();
}

function extractPointBalance(html: string): number | null {
  const directMatch = html.match(/(?:Point Balance|Current Point Balance)\s*:\s*([+-]?\d+)/i);
  if (directMatch?.[1]) return Number(directMatch[1]);

  const plain = toPlainText(html);
  const textMatch = plain.match(/(?:Point Balance|Current Point Balance)\s*:\s*([+-]?\d+)/i);
  if (!textMatch?.[1]) return null;
  return Number(textMatch[1]);
}

function extractWinnerBoxText(html: string): string | null {
  const match = html.match(
    /<p[^>]*class=["'][^"']*winner-box[^"']*["'][^>]*>([\s\S]*?)<\/p>/i
  );
  if (!match?.[1]) return null;
  return toPlainText(match[1]);
}

function extractTagsFromText(text: string): string[] {
  const tags = new Set<string>();
  const hashMatches = text.matchAll(/#([0-9A-Z]{4,})/gi);
  for (const match of hashMatches) {
    if (match[1]) tags.add(normalizeTag(match[1]));
  }
  return [...tags];
}

function extractSyncNumber(text: string): number | null {
  const match = text.match(/sync\s*#\s*(\d+)/i);
  if (!match?.[1]) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
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

function formatPoints(value: number): string {
  return Intl.NumberFormat("en-US").format(value);
}

function getHttpStatus(err: unknown): number | null {
  const status =
    (err as { status?: number } | null | undefined)?.status ??
    (err as { response?: { status?: number } } | null | undefined)?.response?.status;
  return typeof status === "number" ? status : null;
}

async function fetchClanPoints(tag: string): Promise<{
  tag: string;
  url: string;
  balance: number | null;
  clanName: string | null;
  notFound: boolean;
  winnerBoxText: string | null;
  winnerBoxTags: string[];
  winnerBoxSync: number | null;
  effectiveSync: number | null;
  syncMode: "low" | "high" | null;
  winnerBoxHasTag: boolean;
}> {
  const normalizedTag = normalizeTag(tag);
  const url = `${POINTS_BASE_URL}${normalizedTag}`;
  const response = await axios.get<string>(url, {
    timeout: 15000,
    responseType: "text",
    headers: POINTS_REQUEST_HEADERS,
    validateStatus: () => true,
  });
  if (response.status === 403) {
    throw { status: 403, message: "points site returned 403" };
  }
  if (response.status >= 400) {
    throw { status: response.status, message: `points site returned ${response.status}` };
  }

  const html = String(response.data ?? "");
  const balance = extractPointBalance(html);
  const plain = toPlainText(html);
  const clanName = extractField(plain, "Clan Name");
  const notFound = /not found|unknown clan|no clan/i.test(plain);
  const winnerBoxText = extractWinnerBoxText(html);
  const winnerBoxTags = winnerBoxText ? extractTagsFromText(winnerBoxText) : [];
  const winnerBoxSync = winnerBoxText ? extractSyncNumber(winnerBoxText) : null;
  const winnerBoxHasTag = winnerBoxTags.includes(normalizedTag);
  const effectiveSync =
    winnerBoxSync === null ? null : winnerBoxHasTag ? winnerBoxSync : winnerBoxSync + 1;
  const syncMode = getSyncMode(effectiveSync);

  return {
    tag: normalizedTag,
    url,
    balance,
    clanName,
    notFound,
    winnerBoxText,
    winnerBoxTags,
    winnerBoxSync,
    effectiveSync,
    syncMode,
    winnerBoxHasTag,
  };
}

export const Points: Command = {
  name: "points",
  description: "Get FWA points balance and optional matchup projection",
  options: [
    {
      name: "tag",
      description: "Clan tag (with or without #). Leave blank for all tracked clans.",
      type: ApplicationCommandOptionType.String,
      required: false,
      autocomplete: true,
    },
    {
      name: "opponent-tag",
      description: "Opponent clan tag (with or without #)",
      type: ApplicationCommandOptionType.String,
      required: false,
      autocomplete: true,
    },
  ],
  run: async (
    _client: Client,
    interaction: ChatInputCommandInteraction,
    _cocService: CoCService
  ) => {
    await interaction.deferReply({ ephemeral: true });
    const rawTag = interaction.options.getString("tag", false);
    const rawOpponentTag = interaction.options.getString("opponent-tag", false);
    const tag = normalizeTag(rawTag ?? "");
    const opponentTag = normalizeTag(rawOpponentTag ?? "");

    if (!tag && opponentTag) {
      await interaction.editReply(
        "Please provide `tag` when using `opponent-tag`."
      );
      return;
    }

    if (!tag) {
      const tracked = await prisma.trackedClan.findMany({
        orderBy: { createdAt: "asc" },
        select: { name: true, tag: true },
      });

      if (tracked.length === 0) {
        await interaction.editReply(
          "No tracked clans configured. Use `/tracked-clan add` or provide a clan tag."
        );
        return;
      }

      const lines: string[] = [];
      let failedCount = 0;
      let forbiddenCount = 0;
      for (const clan of tracked) {
        const trackedTag = normalizeTag(clan.tag);
        try {
          const result = await fetchClanPoints(trackedTag);
          if (result.balance === null || Number.isNaN(result.balance)) {
            failedCount += 1;
            lines.push(`- ${clan.name ?? `#${trackedTag}`}: unavailable`);
            continue;
          }
          const label = result.clanName ?? clan.name ?? `#${trackedTag}`;
          lines.push(`- ${label} (#${trackedTag}): **${result.balance}**`);
        } catch (err) {
          failedCount += 1;
          if (getHttpStatus(err) === 403) {
            forbiddenCount += 1;
          }
          console.error(
            `[points] bulk request failed tag=${trackedTag} error=${formatError(err)}`
          );
          lines.push(`- ${clan.name ?? `#${trackedTag}`}: unavailable`);
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }

      const header = `Tracked clan points (${tracked.length})`;
      let summary = "";
      if (failedCount > 0) {
        summary = `\n\n${failedCount} clan(s) could not be fetched right now.`;
      }
      if (forbiddenCount > 0) {
        summary +=
          `\n${forbiddenCount} request(s) were blocked by points.fwafarm.com (HTTP 403).`;
      }
      await interaction.editReply(`${header}\n\n${lines.join("\n")}${summary}`);
      return;
    }

    if (opponentTag) {
      if (opponentTag === tag) {
        await interaction.editReply("`tag` and `opponent-tag` must be different clans.");
        return;
      }

      try {
        const [primary, opponent] = await Promise.all([
          fetchClanPoints(tag),
          fetchClanPoints(opponentTag),
        ]);

        if (primary.balance === null || Number.isNaN(primary.balance)) {
          await interaction.editReply(`Could not fetch point balance for #${tag}.`);
          return;
        }
        if (opponent.balance === null || Number.isNaN(opponent.balance)) {
          await interaction.editReply(`Could not fetch point balance for #${opponentTag}.`);
          return;
        }

        const primaryName = primary.clanName ?? `#${tag}`;
        const opponentName = opponent.clanName ?? `#${opponentTag}`;

        let outcome = "";
        if (primary.balance > opponent.balance) {
          outcome = `**${primaryName}** should win by points (${primary.balance} > ${opponent.balance})`;
        } else if (primary.balance < opponent.balance) {
          outcome = `**${primaryName}** should lose by points (${opponent.balance} > ${primary.balance})`;
        } else {
          const syncMode = primary.syncMode ?? opponent.syncMode;
          if (!syncMode) {
            outcome = `Points are tied (${primary.balance} = ${opponent.balance}) but sync number was not found, so tiebreak cannot be determined.`;
          } else {
            const tiebreakCmp = compareTagsForTiebreak(tag, opponentTag);
            if (tiebreakCmp === 0) {
              outcome = `Points are tied (${primary.balance} = ${opponent.balance}) and tags are identical for tiebreak ordering.`;
            } else {
              const primaryWinsTiebreak =
                syncMode === "low" ? tiebreakCmp < 0 : tiebreakCmp > 0;
              outcome = primaryWinsTiebreak
                ? `**${primaryName}** should win by tiebreak (${primary.balance} = ${opponent.balance}, ${syncMode} sync)`
                : `**${primaryName}** should lose by tiebreak (${primary.balance} = ${opponent.balance}, ${syncMode} sync)`;
            }
          }
        }

        const matchupVerified =
          primary.winnerBoxTags.includes(opponentTag) ||
          opponent.winnerBoxTags.includes(tag);
        const verificationNote = matchupVerified
          ? "Matchup verified in winner-box."
          : "Matchup not verified in winner-box yet (site delay possible).";
        const syncNote =
          primary.effectiveSync !== null
            ? `Sync #${primary.effectiveSync} (${primary.syncMode ?? "unknown"} sync)${
                primary.winnerBoxHasTag ? "" : " [adjusted +1 due to stale winner-box tag]"
              }`
            : "Sync not found in winner-box.";

        await interaction.editReply(
          `${primaryName} points: **${formatPoints(primary.balance)}**\n` +
            `${opponentName} points: **${formatPoints(opponent.balance)}**\n\n` +
            `${outcome}\n\n${syncNote}\n${verificationNote}`
        );
        return;
      } catch (err) {
        console.error(
          `[points] matchup request failed tag=${tag} opponent=${opponentTag} error=${formatError(err)}`
        );
        if (getHttpStatus(err) === 403) {
          await interaction.editReply(
            "points.fwafarm.com blocked this request (HTTP 403). Try again later or fetch one clan at a time."
          );
          return;
        }
        await interaction.editReply(
          "Failed to fetch points matchup. Check both tags and try again."
        );
        return;
      }
    }

    try {
      const result = await fetchClanPoints(tag);
      const balance = result.balance;
      if (balance === null || Number.isNaN(balance)) {
        if (result.notFound) {
          await interaction.editReply(
            `No points data found for #${tag}. Check the clan tag and try again.`
          );
          return;
        }

        console.error(`[points] could not parse point balance for tag=${tag} url=${result.url}`);
        await interaction.editReply(
          "Could not parse point balance from points.fwafarm.com right now. Try again later."
        );
        return;
      }

      await interaction.editReply(
        `${result.clanName ? `**${result.clanName}**\n` : ""}Tag: #${tag}\nPoint Balance: **${balance}**\n${result.url}`
      );
    } catch (err) {
      console.error(`[points] request failed tag=${tag} error=${formatError(err)}`);
      if (getHttpStatus(err) === 403) {
        await interaction.editReply(
          "points.fwafarm.com blocked this request (HTTP 403). Try again later."
        );
        return;
      }
      await interaction.editReply(
        "Failed to fetch points. Check the tag and try again."
      );
    }
  },
  autocomplete: async (interaction: AutocompleteInteraction) => {
    const focused = interaction.options.getFocused(true);
    if (focused.name !== "tag" && focused.name !== "opponent-tag") {
      await interaction.respond([]);
      return;
    }

    const query = String(focused.value ?? "").trim().toLowerCase();
    const tracked = await prisma.trackedClan.findMany({
      orderBy: { createdAt: "asc" },
      select: { name: true, tag: true },
    });

    const choices = tracked
      .map((c) => {
        const normalized = normalizeTag(c.tag);
        const label = c.name?.trim() ? `${c.name.trim()} (#${normalized})` : `#${normalized}`;
        return { name: label.slice(0, 100), value: normalized };
      })
      .filter(
        (c) =>
          c.name.toLowerCase().includes(query) ||
          c.value.toLowerCase().includes(query)
      )
      .slice(0, 25);

    await interaction.respond(choices);
  },
};
