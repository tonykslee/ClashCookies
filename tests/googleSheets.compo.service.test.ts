import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import axios from "axios";
import {
  GoogleSheetReadError,
  GoogleSheetsService,
  SHEET_SETTING_ACTUAL_ID_KEY,
  SHEET_SETTING_ID_KEY,
  SHEET_SETTING_TAB_KEY,
  SHEET_SETTING_WAR_ID_KEY,
} from "../src/services/GoogleSheetsService";
import { SettingsService } from "../src/services/SettingsService";

vi.mock("axios", () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

type AxiosMock = {
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
};

type SettingsStubMap = Record<string, string | null>;

function makeSettingsStub(map: SettingsStubMap): SettingsService {
  return {
    get: vi.fn(async (key: string) => map[key] ?? null),
    set: vi.fn(),
    delete: vi.fn(),
  } as unknown as SettingsService;
}

const RANGE = "AllianceDashboard!A6:BE500";

describe("GoogleSheetsService /compo strict read path", () => {
  const mockedAxios = axios as unknown as AxiosMock;
  const originalWebhookUrl = process.env.GS_WEBHOOK_URL;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockedAxios.get.mockReset();
    mockedAxios.post.mockReset();
    delete process.env.GS_WEBHOOK_URL;
  });

  afterEach(() => {
    if (typeof originalWebhookUrl === "string") {
      process.env.GS_WEBHOOK_URL = originalWebhookUrl;
    } else {
      delete process.env.GS_WEBHOOK_URL;
    }
  });

  it("uses google_sheet_id only and does not fall back to legacy keys", async () => {
    const settings = makeSettingsStub({
      [SHEET_SETTING_ID_KEY]: null,
      [SHEET_SETTING_TAB_KEY]: "AllianceDashboard",
      [SHEET_SETTING_ACTUAL_ID_KEY]: "legacy-actual",
      [SHEET_SETTING_WAR_ID_KEY]: "legacy-war",
    });
    const service = new GoogleSheetsService(settings);

    await expect(service.getCompoLinkedSheet(RANGE)).rejects.toMatchObject({
      name: "GoogleSheetReadError",
      code: "SHEET_LINK_MISSING",
    });

    const getSpy = settings.get as unknown as ReturnType<typeof vi.fn>;
    expect(getSpy).toHaveBeenCalledWith(SHEET_SETTING_ID_KEY);
    expect(getSpy).toHaveBeenCalledWith(SHEET_SETTING_TAB_KEY);
    expect(getSpy).not.toHaveBeenCalledWith(SHEET_SETTING_ACTUAL_ID_KEY);
    expect(getSpy).not.toHaveBeenCalledWith(SHEET_SETTING_WAR_ID_KEY);
  });

  it("classifies proxy 403 auth/signature failures as SHEET_PROXY_UNAUTHORIZED", async () => {
    process.env.GS_WEBHOOK_URL = "https://proxy.example.com";
    mockedAxios.post.mockResolvedValue({
      status: 403,
      data: { error: "invalid signature" },
    });
    const service = new GoogleSheetsService(
      makeSettingsStub({
        [SHEET_SETTING_ID_KEY]: "sheet-1",
        [SHEET_SETTING_TAB_KEY]: "AllianceDashboard",
      })
    );

    await expect(service.readCompoLinkedValues(RANGE)).rejects.toMatchObject({
      name: "GoogleSheetReadError",
      code: "SHEET_PROXY_UNAUTHORIZED",
    });
  });

  it("classifies proxy 403 access failures as SHEET_ACCESS_DENIED", async () => {
    process.env.GS_WEBHOOK_URL = "https://proxy.example.com";
    mockedAxios.post.mockResolvedValue({
      status: 403,
      data: { message: "cannot open spreadsheet: not shared" },
    });
    const service = new GoogleSheetsService(
      makeSettingsStub({
        [SHEET_SETTING_ID_KEY]: "sheet-1",
      })
    );

    await expect(service.readCompoLinkedValues(RANGE)).rejects.toMatchObject({
      name: "GoogleSheetReadError",
      code: "SHEET_ACCESS_DENIED",
    });
  });

  it("classifies range/layout failures as SHEET_RANGE_INVALID", async () => {
    process.env.GS_WEBHOOK_URL = "https://proxy.example.com";
    mockedAxios.post.mockResolvedValue({
      status: 400,
      data: { error: "Unable to parse range: AllianceDashboard!A6:BD500" },
    });
    const service = new GoogleSheetsService(
      makeSettingsStub({
        [SHEET_SETTING_ID_KEY]: "sheet-1",
      })
    );

    await expect(service.readCompoLinkedValues(RANGE)).rejects.toMatchObject({
      name: "GoogleSheetReadError",
      code: "SHEET_RANGE_INVALID",
    });
  });

  it("classifies unclear proxy 403 failures as SHEET_READ_FAILURE", async () => {
    process.env.GS_WEBHOOK_URL = "https://proxy.example.com";
    mockedAxios.post.mockResolvedValue({
      status: 403,
      data: { message: "upstream blocked request" },
    });
    const service = new GoogleSheetsService(
      makeSettingsStub({
        [SHEET_SETTING_ID_KEY]: "sheet-1",
      })
    );

    await expect(service.readCompoLinkedValues(RANGE)).rejects.toMatchObject({
      name: "GoogleSheetReadError",
      code: "SHEET_READ_FAILURE",
    });
  });

  it("classifies direct API permission failures as SHEET_ACCESS_DENIED", async () => {
    mockedAxios.get.mockRejectedValue({
      message: "Request failed with status code 403",
      response: {
        status: 403,
        data: { error: { message: "The caller does not have permission" } },
      },
    });
    const service = new GoogleSheetsService(
      makeSettingsStub({
        [SHEET_SETTING_ID_KEY]: "sheet-1",
      })
    );
    vi.spyOn(service as any, "getAccessToken").mockResolvedValue("token-1");

    await expect(service.readCompoLinkedValues(RANGE)).rejects.toMatchObject({
      name: "GoogleSheetReadError",
      code: "SHEET_ACCESS_DENIED",
    });
  });

  it("returns normalized GoogleSheetReadError objects for /compo failures", async () => {
    process.env.GS_WEBHOOK_URL = "https://proxy.example.com";
    mockedAxios.post.mockResolvedValue({
      status: 403,
      data: { error: "invalid signature" },
    });
    const service = new GoogleSheetsService(
      makeSettingsStub({
        [SHEET_SETTING_ID_KEY]: "sheet-1",
      })
    );

    try {
      await service.readCompoLinkedValues(RANGE);
      throw new Error("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(GoogleSheetReadError);
      expect((err as GoogleSheetReadError).meta.range).toBe(RANGE);
      expect((err as GoogleSheetReadError).meta.resolutionSource).toBe("google_sheet_id");
    }
  });
});

