import { beforeEach, describe, expect, it, vi } from "vitest";
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
    const html = "<html><head><title>Login 💎 FWA Stats</title></head></html>";
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

  beforeEach(() => {
    mockedAxios.get.mockReset();
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

  it("returns login_required when fwastats responds with login page", async () => {
    mockedAxios.get.mockResolvedValue({
      status: 200,
      data: "<title>Login 💎 FWA Stats</title>",
    });
    const service = new FwaStatsWeightService();

    const result = await service.getWeightAge("#ABC123");

    expect(result.status).toBe("login_required");
    expect(result.ageText).toBeNull();
  });

  it("uses cached result within ttl", async () => {
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

  it("returns parse_error when expected pattern is missing", async () => {
    mockedAxios.get.mockResolvedValue({
      status: 200,
      data: "<html><body>No weight info here</body></html>",
    });
    const service = new FwaStatsWeightService();

    const result = await service.getWeightAge("#ABC123");

    expect(result.status).toBe("parse_error");
    expect(result.ageText).toBeNull();
  });
});

