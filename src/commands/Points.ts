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

export const Points: Command = {
  name: "points",
  description: "Get FWA points balance for a clan tag",
  options: [
    {
      name: "tag",
      description: "Clan tag (with or without #)",
      type: ApplicationCommandOptionType.String,
      required: true,
      autocomplete: true,
    },
  ],
  run: async (
    _client: Client,
    interaction: ChatInputCommandInteraction,
    _cocService: CoCService
  ) => {
    const rawTag = interaction.options.getString("tag", true);
    const tag = normalizeTag(rawTag);
    if (!tag) {
      await safeReply(interaction, {
        ephemeral: true,
        content: "Please provide a valid clan tag.",
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    const url = `${POINTS_BASE_URL}${tag}`;
    try {
      const response = await axios.get<string>(url, {
        timeout: 15000,
        responseType: "text",
        headers: {
          "User-Agent": "ClashCookiesBot/1.0 (+https://github.com/tonykslee/ClashCookies)",
        },
      });

      const html = String(response.data ?? "");
      const balance = extractPointBalance(html);
      if (balance === null || Number.isNaN(balance)) {
        const plain = toPlainText(html);
        if (/not found|unknown clan|no clan/i.test(plain)) {
          await interaction.editReply(
            `No points data found for #${tag}. Check the clan tag and try again.`
          );
          return;
        }

        console.error(`[points] could not parse point balance for tag=${tag} url=${url}`);
        await interaction.editReply(
          "Could not parse point balance from points.fwafarm.com right now. Try again later."
        );
        return;
      }

      const plain = toPlainText(html);
      const clanName = extractField(plain, "Clan Name");
      const clanTag = extractField(plain, "Clan Tag") ?? tag;
      await interaction.editReply(
        `${clanName ? `**${clanName}**\n` : ""}Tag: #${normalizeTag(clanTag)}\nPoint Balance: **${balance}**\n${url}`
      );
    } catch (err) {
      console.error(`[points] request failed tag=${tag} error=${formatError(err)}`);
      await interaction.editReply(
        "Failed to fetch points. Check the tag and try again."
      );
    }
  },
  autocomplete: async (interaction: AutocompleteInteraction) => {
    const focused = interaction.options.getFocused(true);
    if (focused.name !== "tag") {
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
