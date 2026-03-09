import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import axios from "axios";
import {
  FwaStatsWeightService,
  extractWeightAgeToken,
  isFwaStatsLoginPage,
  parseWeightAgeDays,
} from "../src/services/FwaStatsWeightService";

vi.mock("axios", () => ({
  default: {
    get: vi.fn(),
  },
}));

type AxiosMock = {
  get: ReturnType<typeof vi.fn>;
};

describe("FwaStatsWeightService helpers", () => {
  it("extracts weight age token from HTML", () => {
    const html = `
      <div class="alert alert-success">
        <strong>Clan weight submitted 22d ago.</strong>
      </div>
    `;
    expect(extractWeightAgeToken(html)).toBe("22d");
  });

  it("detects login page HTML", () => {
    const html = "<html><head><title>Login FWA Stats</title></head></html>";
    expect(isFwaStatsLoginPage(html)).toBe(true);
  });

  it("parses age token into days across supported units", () => {
    expect(parseWeightAgeDays("22d")).toBe(22);
    expect(parseWeightAgeDays("2w")).toBe(14);
    expect(parseWeightAgeDays("12h")).toBeCloseTo(0.5);
    expect(parseWeightAgeDays("1 month")).toBe(30);
    expect(parseWeightAgeDays("bad-token")).toBeNull();
  });
});

describe("FwaStatsWeightService", () => {
  const mockedAxios = axios as unknown as AxiosMock;
  const originalCookie = process.env.FWASTATS_WEIGHT_COOKIE;

  beforeEach(() => {
    mockedAxios.get.mockReset();
    delete process.env.FWASTATS_WEIGHT_COOKIE;
  });

  afterEach(() => {
    if (typeof originalCookie === "string") {
      process.env.FWASTATS_WEIGHT_COOKIE = originalCookie;
    } else {
      delete process.env.FWASTATS_WEIGHT_COOKIE;
    }
  });

  it("returns parsed weight age on successful fetch", async () => {
    mockedAxios.get.mockResolvedValue({
      status: 200,
      data: '<strong>Clan weight submitted 9d ago.</strong>',
    });
    const service = new FwaStatsWeightService();

    const result = await service.getWeightAge("#ABC123");

    expect(result.status).toBe("ok");
    expect(result.ageText).toBe("9d ago");
    expect(result.ageDays).toBe(9);
    expect(result.fromCache).toBe(false);
  });

  it("sends Cookie header when FWASTATS_WEIGHT_COOKIE is configured", async () => {
    process.env.FWASTATS_WEIGHT_COOKIE = "session=abc";
    mockedAxios.get.mockResolvedValue({
      status: 200,
      data: '<strong>Clan weight submitted 1d ago.</strong>',
    });
    const service = new FwaStatsWeightService();

    await service.getWeightAge("#ABC123");

    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
    expect(mockedAxios.get.mock.calls[0]?.[1]?.headers?.Cookie).toBe("session=abc");
  });

  it("does not send Cookie header when FWASTATS_WEIGHT_COOKIE is missing", async () => {
    mockedAxios.get.mockResolvedValue({
      status: 200,
      data: '<strong>Clan weight submitted 1d ago.</strong>',
    });
    const service = new FwaStatsWeightService();

    await service.getWeightAge("#ABC123");

    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
    expect(mockedAxios.get.mock.calls[0]?.[1]?.headers?.Cookie).toBeUndefined();
  });

  it("returns login_required_no_cookie when fwastats responds with login page and no cookie", async () => {
    mockedAxios.get.mockResolvedValue({
      status: 200,
      data: "<title>Login FWA Stats</title>",
    });
    const service = new FwaStatsWeightService();

    const result = await service.getWeightAge("#ABC123");

    expect(result.status).toBe("login_required_no_cookie");
    expect(result.ageText).toBeNull();
  });

  it("returns login_required_cookie_rejected when fwastats login page is returned with cookie", async () => {
    process.env.FWASTATS_WEIGHT_COOKIE = "session=abc";
    mockedAxios.get.mockResolvedValue({
      status: 200,
      data: "<title>Login FWA Stats</title>",
    });
    const service = new FwaStatsWeightService();

    const result = await service.getWeightAge("#ABC123");

    expect(result.status).toBe("login_required_cookie_rejected");
    expect(result.ageText).toBeNull();
  });

  it("does not cache auth failures, allowing quick recovery after cookie fix", async () => {
    mockedAxios.get
      .mockResolvedValueOnce({
        status: 200,
        data: "<title>Login FWA Stats</title>",
      })
      .mockResolvedValueOnce({
        status: 200,
        data: '<strong>Clan weight submitted 2d ago.</strong>',
      });
    const service = new FwaStatsWeightService();

    const first = await service.getWeightAge("#ABC123");
    process.env.FWASTATS_WEIGHT_COOKIE = "session=rotated";
    const second = await service.getWeightAge("#ABC123");

    expect(first.status).toBe("login_required_no_cookie");
    expect(second.status).toBe("ok");
    expect(mockedAxios.get).toHaveBeenCalledTimes(2);
  });

  it("uses cached result within ttl for successful responses", async () => {
    mockedAxios.get.mockResolvedValue({
      status: 200,
      data: '<strong>Clan weight submitted 4d ago.</strong>',
    });
    const service = new FwaStatsWeightService();

    const first = await service.getWeightAge("#ABC123");
    const second = await service.getWeightAge("#ABC123");

    expect(first.status).toBe("ok");
    expect(second.status).toBe("ok");
    expect(second.fromCache).toBe(true);
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
  });

  it("caches parse errors briefly", async () => {
    mockedAxios.get.mockResolvedValue({
      status: 200,
      data: "<html><body>No weight info here</body></html>",
    });
    const service = new FwaStatsWeightService();

    const first = await service.getWeightAge("#ABC123");
    const second = await service.getWeightAge("#ABC123");

    expect(first.status).toBe("parse_error");
    expect(second.status).toBe("parse_error");
    expect(second.fromCache).toBe(true);
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
  });

  it("retries once on transient network failure", async () => {
    mockedAxios.get
      .mockRejectedValueOnce({ code: "ECONNRESET", message: "reset" })
      .mockResolvedValueOnce({
        status: 200,
        data: '<strong>Clan weight submitted 1d ago.</strong>',
      });
    const service = new FwaStatsWeightService();

    const result = await service.getWeightAge("#ABC123");

    expect(result.status).toBe("ok");
    expect(result.ageText).toBe("1d ago");
    expect(mockedAxios.get).toHaveBeenCalledTimes(2);
  });
});
