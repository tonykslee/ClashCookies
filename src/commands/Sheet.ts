import axios from "axios";
import {
  ApplicationCommandOptionType,
  ChatInputCommandInteraction,
  Client,
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

function getRefreshErrorHint(err: unknown): string {
  const message = formatError(err).toLowerCase();
  if (message.includes("econnaborted") || message.includes("timeout")) {
    return "Apps Script refresh timed out. The refresh may still be running; try again in a few minutes.";
  }
  if (message.includes("unauthorized") || message.includes("401")) {
    return "Apps Script rejected the shared secret/token. Re-check *_APPS_SCRIPT_SHARED_SECRET.";
  }
  if (message.includes("403")) {
    return "Apps Script endpoint denied access. Re-check web app deployment access and secret.";
  }
  if (message.includes("404")) {
    return "Apps Script webhook URL was not found. Re-check *_APPS_SCRIPT_WEBHOOK_URL.";
  }
  if (message.includes("500")) {
    return "Apps Script returned a server error. Check Apps Script execution logs.";
  }

  return "Could not trigger Apps Script refresh. Check webhook URL, shared secret, deployment access, and Apps Script logs.";
}

const SHEET_MODE_CHOICES = [
  { name: "Actual Roster", value: "actual" },
  { name: "War Roster", value: "war" },
];
const SHEET_REFRESH_COOLDOWN_MS = 5 * 60 * 1000;
const SHEET_REFRESH_TIMEOUT_MS = 120000;
const lastRefreshAtMsByGuildMode = new Map<string, number>();

async function postRefreshWebhook(
  url: string,
  token: string,
  action: "refreshMembers" | "refreshWar"
): Promise<string> {
  const makeRequest = () =>
    axios.post<string>(
      url,
      { token, action },
      {
        headers: { "Content-Type": "application/json" },
        timeout: SHEET_REFRESH_TIMEOUT_MS,
        responseType: "text",
      }
    );

  try {
    const response = await makeRequest();
    return String(response.data ?? "").trim();
  } catch (firstErr) {
    const hint = formatError(firstErr).toLowerCase();
    const retryable =
      hint.includes("timeout") ||
      hint.includes("econnaborted") ||
      hint.includes("socket hang up") ||
      hint.includes("502") ||
      hint.includes("503") ||
      hint.includes("504");

    if (!retryable) throw firstErr;

    const second = await makeRequest();
    return String(second.data ?? "").trim();
  }
}

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
    {
      name: "refresh",
      description: "Trigger Apps Script raw data refresh",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "mode",
          description: "Refresh actual or war raw data",
          type: ApplicationCommandOptionType.String,
          required: true,
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
    let subcommand = "";
    try {
      await interaction.deferReply({ ephemeral: true });

      subcommand = interaction.options.getSubcommand(true);
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

      if (subcommand === "refresh") {
        const refreshMode = interaction.options.getString("mode", true);
        if (refreshMode !== "actual" && refreshMode !== "war") {
          await safeReply(interaction, {
            ephemeral: true,
            content: "Invalid mode. Use actual or war.",
          });
          return;
        }

        const guildModeKey = `${interaction.guildId ?? "dm"}:${refreshMode}`;
        const now = Date.now();
        const lastRun = lastRefreshAtMsByGuildMode.get(guildModeKey);
        if (lastRun && now - lastRun < SHEET_REFRESH_COOLDOWN_MS) {
          const availableAt = Math.floor(
            (lastRun + SHEET_REFRESH_COOLDOWN_MS) / 1000
          );
          await safeReply(interaction, {
            ephemeral: true,
            content: `Refresh cooldown active. Try again <t:${availableAt}:R>.`,
          });
          return;
        }

        const config =
          refreshMode === "actual"
            ? {
                url: process.env.ACTUAL_APPS_SCRIPT_WEBHOOK_URL?.trim(),
                token: process.env.ACTUAL_APPS_SCRIPT_SHARED_SECRET?.trim(),
                action: "refreshMembers",
              }
            : {
                url: process.env.WAR_APPS_SCRIPT_WEBHOOK_URL?.trim(),
                token: process.env.WAR_APPS_SCRIPT_SHARED_SECRET?.trim(),
                action: "refreshWar",
              };

        if (!config.url || !config.token) {
          await safeReply(interaction, {
            ephemeral: true,
            content:
              refreshMode === "actual"
                ? "Missing ACTUAL_APPS_SCRIPT_WEBHOOK_URL or ACTUAL_APPS_SCRIPT_SHARED_SECRET."
                : "Missing WAR_APPS_SCRIPT_WEBHOOK_URL or WAR_APPS_SCRIPT_SHARED_SECRET.",
          });
          return;
        }

        const resultText = await postRefreshWebhook(
          config.url,
          config.token,
          config.action as "refreshMembers" | "refreshWar"
        );

        lastRefreshAtMsByGuildMode.set(guildModeKey, now);
        await safeReply(interaction, {
          ephemeral: true,
          content:
            resultText.length > 0
              ? `Refresh triggered for **${refreshMode.toUpperCase()}** mode.\n${resultText}`
              : `Refresh triggered for **${refreshMode.toUpperCase()}** mode.`,
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
      const hint =
        subcommand === "refresh"
          ? getRefreshErrorHint(err)
          : getSheetErrorHint(err);
      await safeReply(interaction, {
        ephemeral: true,
        content:
          subcommand === "refresh"
            ? `Failed to trigger refresh. ${hint}`
            : `Failed to access Google Sheet. ${hint}`,
      });
    }
  },
};
