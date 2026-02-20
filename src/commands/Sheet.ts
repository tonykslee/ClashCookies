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
import {
  GoogleSheetMode,
  GoogleSheetsService,
} from "../services/GoogleSheetsService";
import { SettingsService } from "../services/SettingsService";

function extractSheetId(input: string): string {
  const trimmed = input.trim();
  const match = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return match?.[1] ?? trimmed;
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

const SHEET_MODE_CHOICES = [
  { name: "Actual Roster", value: "actual" },
  { name: "War Roster", value: "war" },
];

function getModeOptionValue(
  interaction: ChatInputCommandInteraction
): GoogleSheetMode | undefined {
  const raw = interaction.options.getString("mode", false);
  if (raw === "actual" || raw === "war") {
    return raw;
  }
  return undefined;
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
        {
          name: "mode",
          description: "Link sheet for a specific roster mode",
          type: ApplicationCommandOptionType.String,
          required: false,
          choices: SHEET_MODE_CHOICES,
        },
      ],
    },
    {
      name: "show",
      description: "Show current linked Google Sheet",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "mode",
          description: "Show only one roster mode",
          type: ApplicationCommandOptionType.String,
          required: false,
          choices: SHEET_MODE_CHOICES,
        },
      ],
    },
    {
      name: "unlink",
      description: "Unlink the current Google Sheet",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "mode",
          description: "Unlink only one roster mode",
          type: ApplicationCommandOptionType.String,
          required: false,
          choices: SHEET_MODE_CHOICES,
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
        !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
      ) {
        await safeReply(interaction, {
          ephemeral: true,
          content: "You need Administrator permission to use /sheet commands.",
        });
        return;
      }

      await interaction.deferReply({ ephemeral: true });

      const subcommand = interaction.options.getSubcommand(true);
      const mode = getModeOptionValue(interaction);
      const settings = new SettingsService();
      const sheets = new GoogleSheetsService(settings);

      if (subcommand === "show") {
        if (mode) {
          const { sheetId, tabName } = await sheets.getLinkedSheet(mode);
          if (!sheetId) {
            await safeReply(interaction, {
              ephemeral: true,
              content: `No Google Sheet is linked for ${mode} mode yet. Use \`/sheet link\` with mode.`,
            });
            return;
          }

          await safeReply(interaction, {
            ephemeral: true,
            content: `Linked sheet (${mode}): ${sheetId}\nDefault tab: ${tabName ?? "(not set)"}`,
          });
          return;
        }

        const [legacy, actual, war] = await Promise.all([
          sheets.getLinkedSheet(),
          sheets.getLinkedSheet("actual"),
          sheets.getLinkedSheet("war"),
        ]);

        await safeReply(interaction, {
          ephemeral: true,
          content:
            `Legacy/default sheet: ${legacy.sheetId || "(not set)"} | tab: ${legacy.tabName ?? "(not set)"}\n` +
            `Actual mode sheet: ${actual.sheetId || "(not set)"} | tab: ${actual.tabName ?? "(not set)"}\n` +
            `War mode sheet: ${war.sheetId || "(not set)"} | tab: ${war.tabName ?? "(not set)"}`,
        });
        return;
      }

      if (subcommand === "unlink") {
        if (mode) {
          await sheets.clearLinkedSheet(mode);
          await safeReply(interaction, {
            ephemeral: true,
            content: `Google Sheet unlinked for ${mode} mode.`,
          });
          return;
        }

        await Promise.all([
          sheets.clearLinkedSheet(),
          sheets.clearLinkedSheet("actual"),
          sheets.clearLinkedSheet("war"),
        ]);
        await safeReply(interaction, {
          ephemeral: true,
          content: "All Google Sheet links removed (legacy/default, actual, and war).",
        });
        return;
      }

      if (subcommand === "link") {
        const rawInput = interaction.options.getString("sheet_id_or_url", true);
        const sheetId = extractSheetId(rawInput);
        const tab = interaction.options.getString("tab", false) ?? undefined;
        const selectedMode = mode;

        await sheets.testAccess(sheetId, tab);
        await sheets.setLinkedSheet(sheetId, tab, selectedMode);

        await safeReply(interaction, {
          ephemeral: true,
          content:
            `Google Sheet linked${selectedMode ? ` for ${selectedMode} mode` : ""}.\n` +
            `Sheet ID: ${sheetId}\n` +
            `Default tab: ${tab ?? "(unchanged)"}\n` +
            "You can relink anytime with `/sheet link`.",
        });
        return;
      }

      await safeReply(interaction, {
        ephemeral: true,
        content: "Unknown subcommand.",
      });
      return;
    } catch (err) {
      console.error(`sheet command failed: ${formatError(err)}`);
      await safeReply(interaction, {
        ephemeral: true,
        content: `Failed to access Google Sheet. ${getSheetErrorHint(err)}`,
      });
    }
  },
};