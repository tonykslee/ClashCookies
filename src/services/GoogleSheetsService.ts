import axios from "axios";
import { createSign } from "crypto";
import { SettingsService } from "./SettingsService";

export const SHEET_SETTING_ID_KEY = "google_sheet_id";
export const SHEET_SETTING_TAB_KEY = "google_sheet_tab";

type AccessTokenCache = {
  token: string;
  expiresAtMs: number;
};

export class GoogleSheetsService {
  private static accessTokenCache: AccessTokenCache | null = null;

  constructor(private settings: SettingsService) {}

  async getLinkedSheet(): Promise<{ sheetId: string; tabName: string | null }> {
    const sheetId = await this.settings.get(SHEET_SETTING_ID_KEY);
    const tabName = await this.settings.get(SHEET_SETTING_TAB_KEY);
    return { sheetId: sheetId ?? "", tabName };
  }

  async setLinkedSheet(sheetId: string, tabName?: string): Promise<void> {
    await this.settings.set(SHEET_SETTING_ID_KEY, sheetId);
    if (tabName && tabName.trim().length > 0) {
      await this.settings.set(SHEET_SETTING_TAB_KEY, tabName.trim());
    }
  }

  async clearLinkedSheet(): Promise<void> {
    await this.settings.delete(SHEET_SETTING_ID_KEY);
    await this.settings.delete(SHEET_SETTING_TAB_KEY);
  }

  async testAccess(sheetId: string, tabName?: string): Promise<void> {
    const range = tabName?.trim()
      ? `${tabName.trim()}!A1:A1`
      : "A1:A1";
    await this.readValues(sheetId, range);
  }

  async readLinkedValues(range?: string): Promise<string[][]> {
    const { sheetId, tabName } = await this.getLinkedSheet();
    if (!sheetId) {
      throw new Error("No linked Google Sheet found.");
    }

    const effectiveRange = range ?? (tabName ? `${tabName}!A1:D10` : "A1:D10");
    return this.readValues(sheetId, effectiveRange);
  }

  async readValues(sheetId: string, range: string): Promise<string[][]> {
    const token = await this.getAccessToken();
    const encodedRange = encodeURIComponent(range);
    const encodedSheetId = encodeURIComponent(sheetId);
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodedSheetId}/values/${encodedRange}`;

    const response = await axios.get<{ values?: string[][] }>(url, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      timeout: 10000,
    });

    return response.data.values ?? [];
  }

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
      return axios.post<{
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
          timeout: 10000,
        }
      );
    }

    const assertion = this.buildServiceAccountAssertion();
    return axios.post<{
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
        timeout: 10000,
      }
    );
  }

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

  private base64url(input: string | Buffer): string {
    const raw = typeof input === "string" ? Buffer.from(input, "utf8") : input;
    return raw
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
  }
}
