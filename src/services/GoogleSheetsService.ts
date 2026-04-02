import axios from "axios";
import { createSign } from "crypto";
import { recordFetchEvent } from "../helper/fetchTelemetry";
import { toFailureTelemetry } from "./telemetry/ingest";
import { SettingsService } from "./SettingsService";

export const SHEET_SETTING_ID_KEY = "google_sheet_id";
export const SHEET_SETTING_TAB_KEY = "google_sheet_tab";
export const SHEET_SETTING_ACTUAL_ID_KEY = "google_sheet_actual_id";
export const SHEET_SETTING_ACTUAL_TAB_KEY = "google_sheet_actual_tab";
export const SHEET_SETTING_WAR_ID_KEY = "google_sheet_war_id";
export const SHEET_SETTING_WAR_TAB_KEY = "google_sheet_war_tab";
const GOOGLE_API_TIMEOUT_MS = 20000;
const APPS_SCRIPT_PROXY_TIMEOUT_MS = 30000;
const GOOGLE_SHEETS_RW_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const GOOGLE_DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const PROXY_UNAUTHORIZED_SIGNALS = [
  "unauthorized",
  "forbidden",
  "invalid signature",
  "bad secret",
  "shared secret",
  "token",
];
const ACCESS_DENIED_SIGNALS = [
  "permission",
  "access denied",
  "not shared",
  "cannot open spreadsheet",
  "spreadsheet access",
  "insufficient permissions",
];
const RANGE_INVALID_SIGNALS = [
  "unable to parse range",
  "invalid range",
  "range not found",
  "cannot find range",
  "requested entity was not found",
  "exceeds grid limits",
  "cannot find sheet",
  "no grid with id",
  "alliancedashboard",
];

export type GoogleSheetMode = "actual" | "war";
export type GoogleSheetReadErrorCode =
  | "SHEET_LINK_MISSING"
  | "SHEET_PROXY_UNAUTHORIZED"
  | "SHEET_ACCESS_DENIED"
  | "SHEET_RANGE_INVALID"
  | "SHEET_READ_FAILURE";

export type GoogleSheetReadErrorMeta = {
  action: "readValues";
  range: string;
  resolutionSource?: "google_sheet_id";
  sheetId?: string;
  source?: "proxy" | "api";
  httpStatus?: number;
  details?: string;
};

export class GoogleSheetReadError extends Error {
  readonly code: GoogleSheetReadErrorCode;
  readonly meta: GoogleSheetReadErrorMeta;

  constructor(code: GoogleSheetReadErrorCode, message: string, meta: GoogleSheetReadErrorMeta) {
    super(message);
    this.name = "GoogleSheetReadError";
    this.code = code;
    this.meta = meta;
  }
}

type GoogleSheetTransportErrorMeta = {
  source: "proxy" | "api";
  status?: number;
  responseText?: string;
};

class GoogleSheetTransportError extends Error {
  readonly meta: GoogleSheetTransportErrorMeta;

  constructor(message: string, meta: GoogleSheetTransportErrorMeta) {
    super(message);
    this.name = "GoogleSheetTransportError";
    this.meta = meta;
  }
}

export type CompoLinkedSheet = {
  sheetId: string;
  tabName: string | null;
  source: "google_sheet_id";
};

export type GoogleSpreadsheetTabMetadata = {
  sheetId: number;
  title: string;
  index: number;
  hidden: boolean;
};

export type GoogleSpreadsheetMetadata = {
  spreadsheetId: string;
  title: string | null;
  sheets: GoogleSpreadsheetTabMetadata[];
};

export type GoogleSpreadsheetWriteTab = {
  tabName: string;
  values: string[][];
};

export type GoogleSpreadsheetCreateResult = {
  spreadsheetId: string;
  spreadsheetUrl: string;
};

type AccessTokenCache = {
  token: string;
  expiresAtMs: number;
};

export class GoogleSheetsService {
  private static accessTokenCache: AccessTokenCache | null = null;

  /** Purpose: initialize service dependencies. */
  constructor(private settings: SettingsService) {}

  async getLinkedSheet(
    _mode?: GoogleSheetMode
  ): Promise<{ sheetId: string; tabName: string | null }> {
    const sheetId = await this.settings.get(SHEET_SETTING_ID_KEY);
    const tabName = await this.settings.get(SHEET_SETTING_TAB_KEY);
    if (sheetId) return { sheetId, tabName };

    const actualSheetId = await this.settings.get(SHEET_SETTING_ACTUAL_ID_KEY);
    const actualTabName = await this.settings.get(SHEET_SETTING_ACTUAL_TAB_KEY);
    if (actualSheetId) return { sheetId: actualSheetId, tabName: actualTabName };

    const warSheetId = await this.settings.get(SHEET_SETTING_WAR_ID_KEY);
    const warTabName = await this.settings.get(SHEET_SETTING_WAR_TAB_KEY);
    if (warSheetId) return { sheetId: warSheetId, tabName: warTabName };

    return { sheetId: "", tabName: null };
  }

  async setLinkedSheet(
    sheetId: string,
    tabName?: string,
    mode?: GoogleSheetMode
  ): Promise<void> {
    await this.settings.set(SHEET_SETTING_ID_KEY, sheetId);
    if (tabName && tabName.trim().length > 0) {
      await this.settings.set(SHEET_SETTING_TAB_KEY, tabName.trim());
    }
    if (mode) {
      const modeKeys = this.getModeKeys(mode);
      await this.settings.delete(modeKeys.idKey);
      await this.settings.delete(modeKeys.tabKey);
      return;
    }
    await this.settings.delete(SHEET_SETTING_ACTUAL_ID_KEY);
    await this.settings.delete(SHEET_SETTING_ACTUAL_TAB_KEY);
    await this.settings.delete(SHEET_SETTING_WAR_ID_KEY);
    await this.settings.delete(SHEET_SETTING_WAR_TAB_KEY);
  }

  /** Purpose: clear linked sheet. */
  async clearLinkedSheet(mode?: GoogleSheetMode): Promise<void> {
    await this.settings.delete(SHEET_SETTING_ID_KEY);
    await this.settings.delete(SHEET_SETTING_TAB_KEY);
    if (mode) {
      const modeKeys = this.getModeKeys(mode);
      await this.settings.delete(modeKeys.idKey);
      await this.settings.delete(modeKeys.tabKey);
    }
  }

  /** Purpose: test access. */
  async testAccess(sheetId: string, tabName?: string): Promise<void> {
    const range = tabName?.trim()
      ? `${escapeSheetTabName(tabName.trim())}!A1:A1`
      : "A1:A1";
    await this.readValues(sheetId, range);
  }

  async readLinkedValues(
    range?: string,
    mode?: GoogleSheetMode
  ): Promise<string[][]> {
    const { sheetId, tabName } = await this.getLinkedSheet(mode);
    if (!sheetId) {
      if (mode) {
        throw new Error(`No linked Google Sheet found for mode: ${mode}.`);
      }
      throw new Error("No linked Google Sheet found.");
    }

    const effectiveRange = range ?? (tabName ? `${escapeSheetTabName(tabName)}!A1:D10` : "A1:D10");
    return this.readValues(sheetId, effectiveRange);
  }

  /** Purpose: load sheet metadata for workbook-level tab discovery and export introspection. */
  async getSpreadsheetMetadata(sheetId: string): Promise<GoogleSpreadsheetMetadata> {
    const startedAtMs = Date.now();
    const token = await this.getAccessToken();
    const encodedSheetId = encodeURIComponent(sheetId);
    const url =
      `https://sheets.googleapis.com/v4/spreadsheets/${encodedSheetId}` +
      "?fields=spreadsheetId,properties.title,sheets.properties.sheetId,sheets.properties.title,sheets.properties.index,sheets.properties.hidden";

    try {
      const response = await axios.get<{
        spreadsheetId?: string;
        properties?: { title?: string };
        sheets?: Array<{
          properties?: {
            sheetId?: number;
            title?: string;
            index?: number;
            hidden?: boolean;
          };
        }>;
      }>(url, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        timeout: GOOGLE_API_TIMEOUT_MS,
      });
      recordFetchEvent({
        namespace: "google_sheets",
        operation: "read_metadata",
        source: "api",
        detail: `sheet=${sheetId}`,
        durationMs: Date.now() - startedAtMs,
        status: "success",
      });
      return {
        spreadsheetId: String(response.data.spreadsheetId ?? sheetId),
        title: response.data.properties?.title?.trim() || null,
        sheets: (Array.isArray(response.data.sheets) ? response.data.sheets : [])
          .map((sheet) => sheet.properties)
          .filter(
            (
              props,
            ): props is {
              sheetId?: number;
              title?: string;
              index?: number;
              hidden?: boolean;
            } => Boolean(props),
          )
          .map((props) => ({
            sheetId: Number(props.sheetId ?? 0),
            title: String(props.title ?? "").trim(),
            index: Number(props.index ?? 0),
            hidden: Boolean(props.hidden),
          }))
          .filter((sheet) => sheet.sheetId > 0 && sheet.title.length > 0)
          .sort((a, b) => a.index - b.index),
      };
    } catch (err) {
      const failure = toFailureTelemetry(err);
      recordFetchEvent({
        namespace: "google_sheets",
        operation: "read_metadata",
        source: "api",
        detail: `sheet=${sheetId} result=error`,
        durationMs: Date.now() - startedAtMs,
        status: "failure",
        errorCategory: failure.errorCategory,
        errorCode: failure.errorCode,
        timeout: failure.timeout,
      });
      throw new Error(this.errorMessageFromUnknown(err, "Google Sheets metadata request failed."));
    }
  }

  /** Purpose: create one brand-new spreadsheet with the requested tab titles. */
  async createSpreadsheet(input: {
    title: string;
    tabNames?: string[];
  }): Promise<GoogleSpreadsheetCreateResult> {
    const startedAtMs = Date.now();
    const token = await this.getAccessToken();
    const tabs = [...new Set((input.tabNames ?? []).map((tab) => sanitizeSheetTabName(tab)).filter(Boolean))];
    const body: Record<string, unknown> = {
      properties: {
        title: input.title.trim() || "ClashCookies CWL Rotation Export",
      },
    };
    if (tabs.length > 0) {
      body.sheets = tabs.map((title) => ({
        properties: {
          title,
        },
      }));
    }

    try {
      const response = await axios.post<{
        spreadsheetId?: string;
        spreadsheetUrl?: string;
      }>("https://sheets.googleapis.com/v4/spreadsheets", body, {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        timeout: GOOGLE_API_TIMEOUT_MS,
      });
      const spreadsheetId = String(response.data.spreadsheetId ?? "").trim();
      if (!spreadsheetId) {
        throw new Error("Google Sheets create response did not include spreadsheetId.");
      }
      recordFetchEvent({
        namespace: "google_sheets",
        operation: "create_spreadsheet",
        source: "api",
        detail: `sheet=${spreadsheetId}`,
        durationMs: Date.now() - startedAtMs,
        status: "success",
      });
      return {
        spreadsheetId,
        spreadsheetUrl:
          response.data.spreadsheetUrl?.trim() ||
          `https://docs.google.com/spreadsheets/d/${encodeURIComponent(spreadsheetId)}/edit?usp=sharing`,
      };
    } catch (err) {
      const failure = toFailureTelemetry(err);
      recordFetchEvent({
        namespace: "google_sheets",
        operation: "create_spreadsheet",
        source: "api",
        detail: "create_spreadsheet result=error",
        durationMs: Date.now() - startedAtMs,
        status: "failure",
        errorCategory: failure.errorCategory,
        errorCode: failure.errorCode,
        timeout: failure.timeout,
      });
      throw new Error(this.errorMessageFromUnknown(err, "Google Sheets create request failed."));
    }
  }

  /** Purpose: write tab values into one spreadsheet using the Sheets API batch update path. */
  async writeSpreadsheetTabs(input: {
    spreadsheetId: string;
    tabs: GoogleSpreadsheetWriteTab[];
  }): Promise<void> {
    if (input.tabs.length <= 0) return;

    const startedAtMs = Date.now();
    const token = await this.getAccessToken();
    const encodedSheetId = encodeURIComponent(input.spreadsheetId);
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodedSheetId}/values:batchUpdate`;
    const data = input.tabs.map((tab) => ({
      range: `${escapeSheetTabName(tab.tabName)}!A1`,
      values: tab.values,
    }));

    try {
      await axios.post(
        url,
        {
          valueInputOption: "RAW",
          data,
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          timeout: GOOGLE_API_TIMEOUT_MS,
        },
      );
      recordFetchEvent({
        namespace: "google_sheets",
        operation: "write_values",
        source: "api",
        detail: `sheet=${input.spreadsheetId} tabs=${input.tabs.length}`,
        durationMs: Date.now() - startedAtMs,
        status: "success",
      });
    } catch (err) {
      const failure = toFailureTelemetry(err);
      recordFetchEvent({
        namespace: "google_sheets",
        operation: "write_values",
        source: "api",
        detail: `sheet=${input.spreadsheetId} tabs=${input.tabs.length} result=error`,
        durationMs: Date.now() - startedAtMs,
        status: "failure",
        errorCategory: failure.errorCategory,
        errorCode: failure.errorCode,
        timeout: failure.timeout,
      });
      throw new Error(this.errorMessageFromUnknown(err, "Google Sheets write request failed."));
    }
  }

  /** Purpose: make one newly created spreadsheet publicly readable. */
  async makeSpreadsheetPublic(spreadsheetId: string): Promise<void> {
    const startedAtMs = Date.now();
    const token = await this.getAccessToken();
    const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(spreadsheetId)}/permissions?supportsAllDrives=true`;

    try {
      await axios.post(
        url,
        {
          role: "reader",
          type: "anyone",
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          timeout: GOOGLE_API_TIMEOUT_MS,
        },
      );
      recordFetchEvent({
        namespace: "google_sheets",
        operation: "share_public",
        source: "api",
        detail: `sheet=${spreadsheetId}`,
        durationMs: Date.now() - startedAtMs,
        status: "success",
      });
    } catch (err) {
      const failure = toFailureTelemetry(err);
      recordFetchEvent({
        namespace: "google_sheets",
        operation: "share_public",
        source: "api",
        detail: `sheet=${spreadsheetId} result=error`,
        durationMs: Date.now() - startedAtMs,
        status: "failure",
        errorCategory: failure.errorCategory,
        errorCode: failure.errorCode,
        timeout: failure.timeout,
      });
      throw new Error(this.errorMessageFromUnknown(err, "Google Drive permission request failed."));
    }
  }

  async getCompoLinkedSheet(range: string): Promise<CompoLinkedSheet> {
    const sheetId = await this.settings.get(SHEET_SETTING_ID_KEY);
    const tabName = await this.settings.get(SHEET_SETTING_TAB_KEY);
    if (!sheetId || !sheetId.trim()) {
      throw new GoogleSheetReadError(
        "SHEET_LINK_MISSING",
        "No compo sheet is linked for this server.",
        {
          action: "readValues",
          range,
          resolutionSource: "google_sheet_id",
          source: this.getReadSource(),
        }
      );
    }

    return {
      sheetId: sheetId.trim(),
      tabName,
      source: "google_sheet_id",
    };
  }

  async readCompoLinkedValues(
    range: string,
    linkedSheet?: CompoLinkedSheet
  ): Promise<string[][]> {
    const linked = linkedSheet ?? (await this.getCompoLinkedSheet(range));
    try {
      return await this.readValues(linked.sheetId, range);
    } catch (err) {
      throw this.normalizeCompoReadError(err, {
        action: "readValues",
        range,
        resolutionSource: linked.source,
        sheetId: linked.sheetId,
        source: this.getReadSource(),
      });
    }
  }

  /** Purpose: read values. */
  async readValues(sheetId: string, range: string): Promise<string[][]> {
    const proxyUrl = process.env.GS_WEBHOOK_URL?.trim();
    if (proxyUrl) {
      return this.readValuesViaAppsScriptProxy(proxyUrl, sheetId, range);
    }

    const startedAtMs = Date.now();
    const token = await this.getAccessToken();
    const encodedRange = encodeURIComponent(range);
    const encodedSheetId = encodeURIComponent(sheetId);
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodedSheetId}/values/${encodedRange}`;

    try {
      const response = await axios.get<{ values?: string[][] }>(url, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        timeout: GOOGLE_API_TIMEOUT_MS,
      });
      recordFetchEvent({
        namespace: "google_sheets",
        operation: "read_values",
        source: "api",
        detail: `sheet=${sheetId}`,
        durationMs: Date.now() - startedAtMs,
        status: "success",
      });
      return response.data.values ?? [];
    } catch (err) {
      const failure = toFailureTelemetry(err);
      recordFetchEvent({
        namespace: "google_sheets",
        operation: "read_values",
        source: "api",
        detail: `sheet=${sheetId} result=error`,
        durationMs: Date.now() - startedAtMs,
        status: "failure",
        errorCategory: failure.errorCategory,
        errorCode: failure.errorCode,
        timeout: failure.timeout,
      });
      throw new GoogleSheetTransportError(
        this.errorMessageFromUnknown(err, "Google Sheets API request failed."),
        {
          source: "api",
          status: this.readStatusFromUnknown(err),
          responseText: this.errorTextFromUnknown(err),
        }
      );
    }
  }

  private async readValuesViaAppsScriptProxy(
    url: string,
    sheetId: string,
    range: string
  ): Promise<string[][]> {
    const startedAtMs = Date.now();
    const token = process.env.GS_WEBHOOK_SHARED_SECRET?.trim();
    const payload: Record<string, string> = {
      action: "readValues",
      sheetId,
      range,
    };
    if (token) payload.token = token;
    let response: {
      status: number;
      data?: {
        values?: unknown;
        ok?: boolean;
        error?: unknown;
        message?: unknown;
        result?: { values?: unknown };
      };
    };
    try {
      response = await axios.post<{
        values?: unknown;
        ok?: boolean;
        error?: unknown;
        message?: unknown;
        result?: { values?: unknown };
      }>(url, payload, {
        headers: { "Content-Type": "application/json" },
        timeout: APPS_SCRIPT_PROXY_TIMEOUT_MS,
        validateStatus: () => true,
      });
    } catch (err) {
      const failure = toFailureTelemetry(err);
      recordFetchEvent({
        namespace: "google_sheets",
        operation: "apps_script_proxy",
        source: "web",
        detail: "action=readValues status=request_error",
        durationMs: Date.now() - startedAtMs,
        status: "failure",
        errorCategory: failure.errorCategory,
        errorCode: failure.errorCode,
        timeout: failure.timeout,
      });
      throw new GoogleSheetTransportError(
        this.errorMessageFromUnknown(err, "Apps Script proxy request failed."),
        {
          source: "proxy",
          status: this.readStatusFromUnknown(err),
          responseText: this.errorTextFromUnknown(err),
        }
      );
    }

    if (response.status >= 400) {
      recordFetchEvent({
        namespace: "google_sheets",
        operation: "apps_script_proxy",
        source: "web",
        detail: `action=readValues status=${response.status}`,
        durationMs: Date.now() - startedAtMs,
        status: "failure",
        errorCategory: response.status >= 500 ? "upstream_api" : "validation",
        errorCode: `HTTP_${response.status}`,
      });
      const message =
        typeof response.data?.error === "string"
          ? response.data.error
          : typeof response.data?.message === "string"
            ? response.data.message
            : `Apps Script proxy returned HTTP ${response.status}`;
      throw new GoogleSheetTransportError(message, {
        source: "proxy",
        status: response.status,
        responseText: this.compactUnknown(response.data),
      });
    }
    recordFetchEvent({
      namespace: "google_sheets",
      operation: "apps_script_proxy",
      source: "web",
      detail: `action=readValues status=${response.status}`,
      durationMs: Date.now() - startedAtMs,
      status: "success",
    });

    const rawValues =
      response.data?.values ??
      response.data?.result?.values ??
      null;
    if (!Array.isArray(rawValues)) return [];

    return rawValues.map((row) => {
      if (!Array.isArray(row)) return [];
      return row.map((cell) => String(cell ?? ""));
    });
  }

  private getReadSource(): "proxy" | "api" {
    return process.env.GS_WEBHOOK_URL?.trim() ? "proxy" : "api";
  }

  private normalizeCompoReadError(
    err: unknown,
    meta: GoogleSheetReadErrorMeta
  ): GoogleSheetReadError {
    if (err instanceof GoogleSheetReadError) return err;

    const transportMeta =
      err instanceof GoogleSheetTransportError
        ? err.meta
        : {
            source: meta.source,
            status: this.readStatusFromUnknown(err),
            responseText: this.errorTextFromUnknown(err),
          };

    const mergedMeta: GoogleSheetReadErrorMeta = {
      ...meta,
      source: transportMeta.source ?? meta.source,
      httpStatus: transportMeta.status,
      details: transportMeta.responseText,
    };
    const code = this.classifyCompoReadErrorCode(mergedMeta);
    const message = this.errorMessageForCode(code);
    return new GoogleSheetReadError(code, message, mergedMeta);
  }

  private classifyCompoReadErrorCode(
    meta: GoogleSheetReadErrorMeta
  ): GoogleSheetReadErrorCode {
    const source = meta.source ?? "api";
    const status = meta.httpStatus;
    const details = String(meta.details ?? "").toLowerCase();

    if (this.containsSignal(details, RANGE_INVALID_SIGNALS)) {
      return "SHEET_RANGE_INVALID";
    }

    if (source === "proxy") {
      if (status === 401) return "SHEET_PROXY_UNAUTHORIZED";
      if (status === 403) {
        if (this.containsSignal(details, PROXY_UNAUTHORIZED_SIGNALS)) {
          return "SHEET_PROXY_UNAUTHORIZED";
        }
        if (this.containsSignal(details, ACCESS_DENIED_SIGNALS)) {
          return "SHEET_ACCESS_DENIED";
        }
        return "SHEET_READ_FAILURE";
      }
    }

    if (source === "api") {
      if (status === 403) {
        if (
          this.containsSignal(details, ACCESS_DENIED_SIGNALS) ||
          !this.containsSignal(details, PROXY_UNAUTHORIZED_SIGNALS)
        ) {
          return "SHEET_ACCESS_DENIED";
        }
      }
    }

    return "SHEET_READ_FAILURE";
  }

  private containsSignal(input: string, signals: string[]): boolean {
    return signals.some((signal) => input.includes(signal));
  }

  private errorMessageForCode(code: GoogleSheetReadErrorCode): string {
    switch (code) {
      case "SHEET_LINK_MISSING":
        return "No compo sheet is linked for this server.";
      case "SHEET_PROXY_UNAUTHORIZED":
        return "Sheet proxy authorization failed while reading compo data.";
      case "SHEET_ACCESS_DENIED":
        return "The linked sheet could not be accessed.";
      case "SHEET_RANGE_INVALID":
        return "The linked sheet does not contain the expected AllianceDashboard layout.";
      default:
        return "The compo sheet could not be read due to a sheet service error.";
    }
  }

  private readStatusFromUnknown(err: unknown): number | undefined {
    const status = (err as { response?: { status?: unknown } })?.response?.status;
    return typeof status === "number" ? status : undefined;
  }

  private errorMessageFromUnknown(err: unknown, fallback: string): string {
    if (typeof err === "string" && err.trim()) return err.trim();
    if (err instanceof Error && err.message.trim()) return err.message.trim();
    return fallback;
  }

  private errorTextFromUnknown(err: unknown): string | undefined {
    const responseData = (err as { response?: { data?: unknown } })?.response?.data;
    const compactResponse = this.compactUnknown(responseData);
    if (compactResponse) return compactResponse;
    if (typeof err === "string" && err.trim()) return err.trim();
    if (err instanceof Error && err.message.trim()) return err.message.trim();
    return undefined;
  }

  private compactUnknown(value: unknown): string | undefined {
    if (value === null || value === undefined) return undefined;
    if (typeof value === "string") return value.trim() || undefined;
    try {
      const text = JSON.stringify(value);
      return text && text.length > 0 ? text : undefined;
    } catch {
      return undefined;
    }
  }

  /** Purpose: get access token. */
  private async getAccessToken(): Promise<string> {
    const cache = GoogleSheetsService.accessTokenCache;
    const now = Date.now();
    if (cache && cache.expiresAtMs - 30_000 > now) {
      return cache.token;
    }

    const tokenRes = await this.requestAccessToken();

    const token = tokenRes.data.access_token;
    const expiresIn = tokenRes.data.expires_in ?? 3600;
    GoogleSheetsService.accessTokenCache = {
      token,
      expiresAtMs: now + expiresIn * 1000,
    };

    return token;
  }

  /** Purpose: request access token. */
  private async requestAccessToken(): Promise<{
    data: {
      access_token: string;
      expires_in: number;
      token_type: string;
    };
  }> {
    const startedAtMs = Date.now();
    const oauthClientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim();
    const oauthClientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
    const oauthRefreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN?.trim();

    if (oauthClientId && oauthClientSecret && oauthRefreshToken) {
      try {
        const response = await axios.post<{
          access_token: string;
          expires_in: number;
          token_type: string;
        }>(
          "https://oauth2.googleapis.com/token",
          new URLSearchParams({
            grant_type: "refresh_token",
            client_id: oauthClientId,
            client_secret: oauthClientSecret,
            refresh_token: oauthRefreshToken,
          }).toString(),
          {
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            timeout: GOOGLE_API_TIMEOUT_MS,
          }
        );
        recordFetchEvent({
          namespace: "google_oauth",
          operation: "token_exchange",
          source: "api",
          detail: "grant=refresh_token",
          durationMs: Date.now() - startedAtMs,
          status: "success",
        });
        return response;
      } catch (err) {
        const failure = toFailureTelemetry(err);
        recordFetchEvent({
          namespace: "google_oauth",
          operation: "token_exchange",
          source: "api",
          detail: "grant=refresh_token result=error",
          durationMs: Date.now() - startedAtMs,
          status: "failure",
          errorCategory: failure.errorCategory,
          errorCode: failure.errorCode,
          timeout: failure.timeout,
        });
        throw err;
      }
    }

    const assertion = this.buildServiceAccountAssertion();
    try {
      const response = await axios.post<{
        access_token: string;
        expires_in: number;
        token_type: string;
      }>(
        "https://oauth2.googleapis.com/token",
        new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion,
        }).toString(),
        {
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          timeout: GOOGLE_API_TIMEOUT_MS,
        }
      );
      recordFetchEvent({
        namespace: "google_oauth",
        operation: "token_exchange",
        source: "api",
        detail: "grant=jwt_bearer",
        durationMs: Date.now() - startedAtMs,
        status: "success",
      });
      return response;
    } catch (err) {
      const failure = toFailureTelemetry(err);
      recordFetchEvent({
        namespace: "google_oauth",
        operation: "token_exchange",
        source: "api",
        detail: "grant=jwt_bearer result=error",
        durationMs: Date.now() - startedAtMs,
        status: "failure",
        errorCategory: failure.errorCategory,
        errorCode: failure.errorCode,
        timeout: failure.timeout,
      });
      throw err;
    }
  }

  /** Purpose: build service account assertion. */
  private buildServiceAccountAssertion(): string {
    const { clientEmail, privateKey } = this.readServiceAccountFromEnv();
    const nowSeconds = Math.floor(Date.now() / 1000);
    const header = { alg: "RS256", typ: "JWT" };
    const payload = {
      iss: clientEmail,
      scope: `${GOOGLE_SHEETS_RW_SCOPE} ${GOOGLE_DRIVE_FILE_SCOPE}`,
      aud: "https://oauth2.googleapis.com/token",
      iat: nowSeconds,
      exp: nowSeconds + 3600,
    };

    const encodedHeader = this.base64url(JSON.stringify(header));
    const encodedPayload = this.base64url(JSON.stringify(payload));
    const body = `${encodedHeader}.${encodedPayload}`;

    const signer = createSign("RSA-SHA256");
    signer.update(body);
    signer.end();

    const signature = signer.sign(privateKey);
    return `${body}.${this.base64url(signature)}`;
  }

  /** Purpose: read service account from env. */
  private readServiceAccountFromEnv(): {
    clientEmail: string;
    privateKey: string;
  } {
    const jsonRaw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
    const jsonB64 = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64?.trim();

    if (jsonRaw || jsonB64) {
      const jsonText = jsonRaw
        ? jsonRaw
        : Buffer.from(jsonB64 as string, "base64").toString("utf8");

      const parsed = JSON.parse(jsonText) as {
        client_email?: string;
        private_key?: string;
      };

      const clientEmail = parsed.client_email?.trim();
      const privateKey = parsed.private_key?.replace(/\\n/g, "\n").trim();
      if (!clientEmail || !privateKey) {
        throw new Error(
          "GOOGLE_SERVICE_ACCOUNT_JSON(_BASE64) is missing client_email or private_key."
        );
      }
      return { clientEmail, privateKey };
    }

    const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL?.trim();
    const privateKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
      ?.replace(/\\n/g, "\n")
      .trim();

    if (!clientEmail || !privateKey) {
      throw new Error(
        "Google Sheets credentials missing. Set OAuth env vars (GOOGLE_OAUTH_CLIENT_ID/SECRET/REFRESH_TOKEN) or service-account vars."
      );
    }

    return { clientEmail, privateKey };
  }

  /** Purpose: base64url. */
  private base64url(input: string | Buffer): string {
    const raw = typeof input === "string" ? Buffer.from(input, "utf8") : input;
    return raw
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
  }

  /** Purpose: get mode keys. */
  private getModeKeys(mode: GoogleSheetMode): { idKey: string; tabKey: string } {
    if (mode === "actual") {
      return {
        idKey: SHEET_SETTING_ACTUAL_ID_KEY,
        tabKey: SHEET_SETTING_ACTUAL_TAB_KEY,
      };
    }

    return {
      idKey: SHEET_SETTING_WAR_ID_KEY,
      tabKey: SHEET_SETTING_WAR_TAB_KEY,
    };
  }
}

function escapeSheetTabName(tabName: string): string {
  const escaped = String(tabName ?? "").trim().replace(/'/g, "''");
  return `'${escaped}'`;
}

function sanitizeSheetTabName(tabName: string): string {
  return String(tabName ?? "")
    .trim()
    .replace(/\[/g, " ")
    .replace(/\]/g, " ")
    .replace(/[*?:/\\]/g, " ")
    .replace(/\s+/g, " ")
    .slice(0, 100)
    .trim() || "Sheet";
}
