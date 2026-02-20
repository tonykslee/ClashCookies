import {
  ApplicationCommandOptionType,
  ChatInputCommandInteraction,
  Client,
  PermissionFlagsBits,
} from "discord.js";
import { Command } from "../Command";
import { formatError } from "../helper/formatError";
import { safeReply } from "../helper/safeReply";
import { CoCService } from "../services/CoCService";
import { GoogleSheetsService } from "../services/GoogleSheetsService";
import { SettingsService } from "../services/SettingsService";

function extractSheetId(input: string): string {
  const trimmed = input.trim();
  const match = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return match?.[1] ?? trimmed;
}

function clampCell(value: string): string {
  const sanitized = value.replace(/\s+/g, " ").trim();
  return sanitized.length > 40 ? `${sanitized.slice(0, 37)}...` : sanitized;
}

function getSheetErrorHint(err: unknown): string {
  const message = formatError(err).toLowerCase();

  if (message.includes("invalid_grant")) {
    return "Invalid Google auth grant. For OAuth, re-check GOOGLE_OAUTH_* values and refresh token.";
  }
  if (
    message.includes("invalid_client") ||
    message.includes("unauthorized_client")
  ) {
    return "OAuth client is invalid/unauthorized. Re-check GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET.";
  }
  if (
    message.includes("permission denied") ||
    message.includes("does not have permission") ||
    message.includes("403")
  ) {
    return "Share the sheet with your service account or OAuth Google account as Viewer/Editor.";
  }
  if (message.includes("requested entity was not found") || message.includes("404")) {
    return "Sheet ID looks invalid or the sheet is not accessible to this account.";
  }
  if (message.includes("unable to parse range") || message.includes("badrequest")) {
    return "Range/tab is invalid. Try a valid tab name or omit range.";
  }
  if (message.includes("relation \"botsetting\" does not exist")) {
    return "Database migration missing. Run prisma migrate deploy for BotSetting.";
  }

  return "Check credentials, sharing, sheet ID, and optional tab/range.";
}

export const Sheet: Command = {
  name: "sheet",
  description: "Manage Google Sheet link for this bot",
  options: [
    {
      name: "link",
      description: "Link or update the active Google Sheet",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "sheet_id_or_url",
          description: "Google Sheet ID or full URL",
          type: ApplicationCommandOptionType.String,
          required: true,
        },
        {
          name: "tab",
          description: "Default tab name (optional)",
          type: ApplicationCommandOptionType.String,
          required: false,
        },
      ],
    },
    {
      name: "show",
      description: "Show current linked Google Sheet",
      type: ApplicationCommandOptionType.Subcommand,
    },
    {
      name: "unlink",
      description: "Unlink the current Google Sheet",
      type: ApplicationCommandOptionType.Subcommand,
    },
    {
      name: "preview",
      description: "Preview rows from the linked Google Sheet",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "range",
          description: "A1 notation range, e.g. Sheet1!A1:D10",
          type: ApplicationCommandOptionType.String,
          required: false,
        },
      ],
    },
  ],
  run: async (
    _client: Client,
    interaction: ChatInputCommandInteraction,
    _cocService: CoCService
  ) => {
    try {
      if (
        interaction.inGuild() &&
        !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)
      ) {
        await safeReply(interaction, {
          ephemeral: true,
          content: "You need Manage Server permission to manage sheet settings.",
        });
        return;
      }

      await interaction.deferReply({ ephemeral: true });

      const subcommand = interaction.options.getSubcommand(true);
      const settings = new SettingsService();
      const sheets = new GoogleSheetsService(settings);

      if (subcommand === "show") {
        const { sheetId, tabName } = await sheets.getLinkedSheet();
        if (!sheetId) {
          await safeReply(interaction, {
            ephemeral: true,
            content: "No Google Sheet is linked yet. Use `/sheet link`.",
          });
          return;
        }

        await safeReply(interaction, {
          ephemeral: true,
          content: `Linked sheet: ${sheetId}\nDefault tab: ${tabName ?? "(not set)"}`,
        });
        return;
      }

      if (subcommand === "unlink") {
        await sheets.clearLinkedSheet();
        await safeReply(interaction, {
          ephemeral: true,
          content: "Google Sheet unlinked.",
        });
        return;
      }

      if (subcommand === "link") {
        const rawInput = interaction.options.getString("sheet_id_or_url", true);
        const sheetId = extractSheetId(rawInput);
        const tab = interaction.options.getString("tab", false) ?? undefined;

        await sheets.testAccess(sheetId, tab);
        await sheets.setLinkedSheet(sheetId, tab);

        await safeReply(interaction, {
          ephemeral: true,
          content: `Google Sheet linked.\nSheet ID: ${sheetId}\nDefault tab: ${tab ?? "(unchanged)"}\nYou can relink anytime with \`/sheet link\`.`,
        });
        return;
      }

      if (subcommand === "preview") {
        const range = interaction.options.getString("range", false) ?? undefined;
        const values = await sheets.readLinkedValues(range);

        if (values.length === 0) {
          await safeReply(interaction, {
            ephemeral: true,
            content: "No rows found for that range.",
          });
          return;
        }

        const rendered = values
          .slice(0, 8)
          .map((row) => row.slice(0, 5).map(clampCell).join(" | "))
          .join("\n");
        const suffix = values.length > 8 ? `\n...and ${values.length - 8} more row(s).` : "";

        await safeReply(interaction, {
          ephemeral: true,
          content: `Preview (${range ?? "default range"}):\n\`\`\`\n${rendered}\n\`\`\`${suffix}`,
        });
      }
    } catch (err) {
      console.error(`sheet command failed: ${formatError(err)}`);
      await safeReply(interaction, {
        ephemeral: true,
        content: `Failed to access Google Sheet. ${getSheetErrorHint(err)}`,
      });
    }
  },
};
