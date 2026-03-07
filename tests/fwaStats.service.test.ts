import { beforeEach, describe, expect, it, vi } from "vitest";
import axios from "axios";
import { FwaStatsService } from "../src/services/FwaStatsService";

vi.mock("axios", () => ({
  default: {
    get: vi.fn(),
  },
}));

type AxiosMock = {
  get: ReturnType<typeof vi.fn>;
};

describe("FwaStatsService", () => {
  const mockedAxios = axios as unknown as AxiosMock;

  beforeEach(() => {
    mockedAxios.get.mockReset();
  });

  it("returns true when opponent is present in active wars", async () => {
    mockedAxios.get.mockResolvedValue({
      status: 200,
      data: [
        { opponentTag: "#ABC123", matched: true, synced: true },
        { opponentTag: "#ZZZ999", matched: true, synced: false },
      ],
    });
    const service = new FwaStatsService();

    const result = await service.isOpponentInActiveWars("#TAG1", "#ABC123");

    expect(result).toBe(true);
  });

  it("ignores rows explicitly not matched and not synced", async () => {
    mockedAxios.get.mockResolvedValue({
      status: 200,
      data: [{ opponentTag: "#ABC123", matched: false, synced: false }],
    });
    const service = new FwaStatsService();

    const result = await service.isOpponentInActiveWars("#TAG1", "#ABC123");

    expect(result).toBe(false);
  });

  it("uses cached response within ttl", async () => {
    mockedAxios.get.mockResolvedValue({
      status: 200,
      data: [{ opponentTag: "#ABC123", matched: true, synced: true }],
    });
    const service = new FwaStatsService();

    const first = await service.isOpponentInActiveWars("#TAG1", "#ABC123");
    const second = await service.isOpponentInActiveWars("#TAG1", "#ABC123");

    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
  });

  it("returns null when fwastats request fails", async () => {
    mockedAxios.get.mockResolvedValue({
      status: 500,
      data: [],
    });
    const service = new FwaStatsService();

    const result = await service.isOpponentInActiveWars("#TAG1", "#ABC123");

    expect(result).toBeNull();
  });
});

