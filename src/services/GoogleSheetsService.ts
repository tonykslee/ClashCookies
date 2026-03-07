import axios from "axios";
import { createSign } from "crypto";
import { recordFetchEvent } from "../helper/fetchTelemetry";
import { SettingsService } from "./SettingsService";

export const SHEET_SETTING_ID_KEY = "google_sheet_id";
export const SHEET_SETTING_TAB_KEY = "google_sheet_tab";
export const SHEET_SETTING_ACTUAL_ID_KEY = "google_sheet_actual_id";
export const SHEET_SETTING_ACTUAL_TAB_KEY = "google_sheet_actual_tab";
export const SHEET_SETTING_WAR_ID_KEY = "google_sheet_war_id";
export const SHEET_SETTING_WAR_TAB_KEY = "google_sheet_war_tab";
const GOOGLE_API_TIMEOUT_MS = 20000;
const APPS_SCRIPT_PROXY_TIMEOUT_MS = 30000;

export type GoogleSheetMode = "actual" | "war";

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

  /** Purpose: read values. */
  async readValues(sheetId: string, range: string): Promise<string[][]> {
    const proxyUrl = process.env.GS_WEBHOOK_URL?.trim();
    if (proxyUrl) {
      return this.readValuesViaAppsScriptProxy(proxyUrl, sheetId, range);
    }

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
      });
      return response.data.values ?? [];
    } catch (err) {
      recordFetchEvent({
        namespace: "google_sheets",
        operation: "read_values",
        source: "api",
        detail: `sheet=${sheetId} result=error`,
      });
      throw err;
    }
  }

  private async readValuesViaAppsScriptProxy(
    url: string,
    sheetId: string,
    range: string
  ): Promise<string[][]> {
    const token = process.env.GS_WEBHOOK_SHARED_SECRET?.trim();
    const payload: Record<string, string> = {
      action: "readValues",
      sheetId,
      range,
    };
    if (token) payload.token = token;

    const response = await axios.post<{
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

    if (response.status >= 400) {
      recordFetchEvent({
        namespace: "google_sheets",
        operation: "apps_script_proxy",
        source: "web",
        detail: `action=readValues status=${response.status}`,
      });
      const message =
        typeof response.data?.error === "string"
          ? response.data.error
          : typeof response.data?.message === "string"
            ? response.data.message
            : `Apps Script proxy returned HTTP ${response.status}`;
      throw new Error(message);
    }
    recordFetchEvent({
      namespace: "google_sheets",
      operation: "apps_script_proxy",
      source: "web",
      detail: `action=readValues status=${response.status}`,
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
    const oauthClientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim();
    const oauthClientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
    const oauthRefreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN?.trim();

    if (oauthClientId && oauthClientSecret && oauthRefreshToken) {
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
      });
      return response;
    }

    const assertion = this.buildServiceAccountAssertion();
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
    });
    return response;
  }

  /** Purpose: build service account assertion. */
  private buildServiceAccountAssertion(): string {
    const { clientEmail, privateKey } = this.readServiceAccountFromEnv();
    const nowSeconds = Math.floor(Date.now() / 1000);
    const header = { alg: "RS256", typ: "JWT" };
    const payload = {
      iss: clientEmail,
      scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
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
