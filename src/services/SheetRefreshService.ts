import axios from "axios";
import { formatError } from "../helper/formatError";
import { recordFetchEvent } from "../helper/fetchTelemetry";
import { isMirrorPollingMode } from "./PollingModeService";

export type SheetRefreshMode = "actual" | "war";
type SheetRefreshAction = "refreshMembers" | "refreshWar";

const SHEET_REFRESH_COOLDOWN_MS = 5 * 60 * 1000;
const SHEET_REFRESH_TIMEOUT_MS = 120000;
const lastRefreshAtMsByGuild = new Map<string, number>();

type SheetRefreshFlowErrorCode =
  | "INVALID_MODE"
  | "COOLDOWN_ACTIVE"
  | "MISSING_WEBHOOK_URL"
  | "MIRROR_MODE_DISABLED";

export class SheetRefreshFlowError extends Error {
  readonly code: SheetRefreshFlowErrorCode;
  readonly retryAtEpochSeconds: number | null;

  constructor(
    code: SheetRefreshFlowErrorCode,
    message: string,
    options?: {
      retryAtEpochSeconds?: number | null;
    }
  ) {
    super(message);
    this.name = "SheetRefreshFlowError";
    this.code = code;
    this.retryAtEpochSeconds =
      options?.retryAtEpochSeconds !== undefined ? options.retryAtEpochSeconds : null;
  }
}

function resolveSheetRefreshAction(mode: SheetRefreshMode): SheetRefreshAction {
  return mode === "actual" ? "refreshMembers" : "refreshWar";
}

async function postRefreshWebhook(
  url: string,
  token: string | null,
  action: SheetRefreshAction
): Promise<string> {
  const payload: Record<string, string> = { action };
  if (token) payload.token = token;
  const makeRequest = () =>
    axios.post<string>(url, payload, {
      headers: { "Content-Type": "application/json" },
      timeout: SHEET_REFRESH_TIMEOUT_MS,
      responseType: "text",
    });

  try {
    const response = await makeRequest();
    recordFetchEvent({
      namespace: "google_sheets",
      operation: "apps_script_refresh",
      source: "web",
      detail: `action=${action} status=${response.status}`,
    });
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
    recordFetchEvent({
      namespace: "google_sheets",
      operation: "apps_script_refresh",
      source: "web",
      detail: `action=${action} status=${second.status} retry=true`,
    });
    return String(second.data ?? "").trim();
  }
}

export function mapSheetRefreshFlowErrorToMessage(err: SheetRefreshFlowError): string {
  if (err.code === "INVALID_MODE") return "Invalid mode. Use actual or war.";
  if (err.code === "MIRROR_MODE_DISABLED") {
    return "Sheet refresh is disabled while POLLING_MODE=mirror.";
  }
  if (err.code === "MISSING_WEBHOOK_URL") return "Missing GS_WEBHOOK_URL.";
  if (err.code === "COOLDOWN_ACTIVE" && err.retryAtEpochSeconds) {
    return `Refresh cooldown active. Try again <t:${err.retryAtEpochSeconds}:R>.`;
  }
  return "Failed to trigger refresh.";
}

export function getSheetRefreshErrorHint(err: unknown): string {
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

export async function triggerSharedSheetRefresh(input: {
  guildId: string | null | undefined;
  mode: SheetRefreshMode;
}): Promise<{ mode: SheetRefreshMode; resultText: string; durationSeconds: string }> {
  if (isMirrorPollingMode(process.env)) {
    console.warn(
      `[sheet-refresh] event=skipped reason=mirror_mode guild=${input.guildId ?? "dm"}`,
    );
    throw new SheetRefreshFlowError(
      "MIRROR_MODE_DISABLED",
      "sheet refresh disabled in mirror mode",
    );
  }

  const mode = input.mode;
  if (mode !== "actual" && mode !== "war") {
    throw new SheetRefreshFlowError("INVALID_MODE", "invalid mode");
  }

  const guildKey = `${input.guildId ?? "dm"}`;
  const now = Date.now();
  const lastRun = lastRefreshAtMsByGuild.get(guildKey);
  if (lastRun && now - lastRun < SHEET_REFRESH_COOLDOWN_MS) {
    const availableAt = Math.floor((lastRun + SHEET_REFRESH_COOLDOWN_MS) / 1000);
    throw new SheetRefreshFlowError("COOLDOWN_ACTIVE", "cooldown active", {
      retryAtEpochSeconds: availableAt,
    });
  }

  const url = process.env.GS_WEBHOOK_URL?.trim();
  if (!url) {
    throw new SheetRefreshFlowError("MISSING_WEBHOOK_URL", "missing GS_WEBHOOK_URL");
  }

  const token = process.env.GS_WEBHOOK_SHARED_SECRET?.trim() ?? null;
  const action = resolveSheetRefreshAction(mode);
  const refreshStartedAtMs = Date.now();
  const resultText = await postRefreshWebhook(url, token, action);
  const durationSeconds = ((Date.now() - refreshStartedAtMs) / 1000).toFixed(2);

  lastRefreshAtMsByGuild.set(guildKey, now);
  return {
    mode,
    resultText,
    durationSeconds,
  };
}
