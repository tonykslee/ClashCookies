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
import { GoogleSheetsService } from "../services/GoogleSheetsService";
import { SettingsService } from "../services/SettingsService";

function extractSheetId(input: string): string {
  const trimmed = input.trim();
  const match = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return match?.[1] ?? trimmed;
}

function getSheetErrorHint(err: unknown): string {
  const message = formatError(err).toLowerCase();
  const usingProxy = Boolean(process.env.GS_WEBHOOK_URL?.trim());

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
  if (usingProxy) {
    return "Apps Script proxy read failed. Check GS_WEBHOOK_URL deployment access, readValues action support, and Apps Script logs.";
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
    return "Apps Script webhook URL was not found. Re-check GS_WEBHOOK_URL.";
  }
  if (message.includes("500")) {
    return "Apps Script returned a server error. Check Apps Script execution logs.";
  }

  return "Could not trigger Apps Script refresh. Check webhook URL, shared secret, deployment access, and Apps Script logs.";
}

const SHEET_REFRESH_MODE_CHOICES = [
  { name: "Actual", value: "actual" },
  { name: "War", value: "war" },
];
const SHEET_REFRESH_COOLDOWN_MS = 5 * 60 * 1000;
const SHEET_REFRESH_TIMEOUT_MS = 120000;
const lastRefreshAtMsByGuild = new Map<string, number>();
const SHEET_LINK_PREREQUISITES = [
  "Prerequisites:",
  "1. Share the sheet with Google service account as Editor: `clashcookies-serviceaccount@project-61d5243b-bd8a-4eae-b4f.iam.gserviceaccount.com`",
  "2. In Sheets -> Extensions -> Apps Script -> Project Settings, add Script Property `APPS_SCRIPT_SHARED_SECRET` with any alphanumeric key.",
  "3. Set that same key in bot env var `GS_WEBHOOK_SHARED_SECRET`.",
  "4. In Apps Script, deploy a Web App and set its URL in bot env var `GS_WEBHOOK_URL`.",
].join("\n");

async function postRefreshWebhook(
  url: string,
  token: string | null,
  action: "refreshMembers" | "refreshWar"
): Promise<string> {
  const payload: Record<string, string> = { action };
  if (token) payload.token = token;
  const makeRequest = () =>
    axios.post<string>(
      url,
      payload,
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
      name: "refresh",
      description: "Trigger Apps Script raw data refresh",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "mode",
          description: "Refresh actual or war raw data",
          type: ApplicationCommandOptionType.String,
          required: false,
          choices: SHEET_REFRESH_MODE_CHOICES,
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
      const settings = new SettingsService();
      const sheets = new GoogleSheetsService(settings);

      if (subcommand === "show") {
        const { sheetId, tabName } = await sheets.getLinkedSheet();
        await safeReply(interaction, {
          ephemeral: true,
          content: sheetId
            ? `Linked sheet: ${sheetId}\nDefault tab: ${tabName ?? "(not set)"}`
            : "No Google Sheet is linked yet. Use `/sheet link`.",
        });
        return;
      }

      if (subcommand === "unlink") {
        await Promise.all([sheets.clearLinkedSheet(), sheets.clearLinkedSheet("actual"), sheets.clearLinkedSheet("war")]);
        await safeReply(interaction, {
          ephemeral: true,
          content: "Google Sheet link removed.",
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
          content:
            `Google Sheet linked.\nSheet ID: ${sheetId}\n` +
            `Default tab: ${tab ?? "(unchanged)"}\n` +
            "You can relink anytime with `/sheet link`.\n\n" +
            SHEET_LINK_PREREQUISITES,
        });
        return;
      }

      if (subcommand === "refresh") {
        const refreshMode = interaction.options.getString("mode", false) ?? "actual";
        if (refreshMode !== "actual" && refreshMode !== "war") {
          await safeReply(interaction, {
            ephemeral: true,
            content: "Invalid mode. Use actual or war.",
          });
          return;
        }

        const guildKey = `${interaction.guildId ?? "dm"}`;
        const now = Date.now();
        const lastRun = lastRefreshAtMsByGuild.get(guildKey);
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

        const config = {
          url: process.env.GS_WEBHOOK_URL?.trim(),
          token: process.env.GS_WEBHOOK_SHARED_SECRET?.trim() ?? null,
          action: refreshMode === "actual" ? "refreshMembers" : "refreshWar",
        } as const;

        if (!config.url) {
          await safeReply(interaction, {
            ephemeral: true,
            content: "Missing GS_WEBHOOK_URL.",
          });
          return;
        }

        const refreshStartedAtMs = Date.now();
        const resultText = await postRefreshWebhook(
          config.url,
          config.token,
          config.action as "refreshMembers" | "refreshWar"
        );
        const refreshDurationSeconds = (
          (Date.now() - refreshStartedAtMs) /
          1000
        ).toFixed(2);

        lastRefreshAtMsByGuild.set(guildKey, now);
        await safeReply(interaction, {
          ephemeral: true,
          content:
            resultText.length > 0
              ? `Refresh triggered for **${refreshMode.toUpperCase()}** mode in **${refreshDurationSeconds}s**.\n${resultText}`
              : `Refresh triggered for **${refreshMode.toUpperCase()}** mode in **${refreshDurationSeconds}s**.`,
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
            : subcommand === "link"
              ? `Failed to access Google Sheet. ${hint}\n\n${SHEET_LINK_PREREQUISITES}`
              : `Failed to access Google Sheet. ${hint}`,
      });
    }
  },
};
