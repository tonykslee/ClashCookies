import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import axios from "axios";
import { runWithCoCQueueContext } from "../src/services/CoCQueueContext";

vi.mock("../src/services/CoCRequestQueueService", () => ({
  cocRequestQueueService: {
    enqueue: vi.fn(async (task: { run: () => Promise<unknown> }) => task.run()),
  },
}));

import { CoCService } from "../src/services/CoCService";

describe("CoCService current war error wrapping", () => {
  const envSnapshot = process.env.COC_API_TOKEN;

  beforeEach(() => {
    process.env.COC_API_TOKEN = "test-token";
  });

  afterEach(() => {
    process.env.COC_API_TOKEN = envSnapshot;
    delete process.env.COC_API_REQUEST_TIMEOUT_MS;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("preserves the upstream response body on getCurrentWar failures", async () => {
    const service = new CoCService();
    (service as any).clansApi = {
      getCurrentWar: vi.fn().mockRejectedValue({
        message: "Request failed with status code 503",
        code: "ERR_BAD_RESPONSE",
        response: {
          status: 503,
          data: {
            message: "Service temporarily unavailable because of maintenance.",
          },
        },
      }),
    };

    const error = await runWithCoCQueueContext(
      { priority: "background", source: "test" },
      async () => {
        try {
          await service.getCurrentWar("#ABC123");
          return null;
        } catch (err) {
          return err;
        }
      },
    );

    expect(error).toMatchObject({
      message: "CoC API error 503",
      status: 503,
      response: {
        status: 503,
        data: {
          message: "Service temporarily unavailable because of maintenance.",
        },
      },
    });
  });

  it("preserves runtime leagueTier and modern player fields when normalizing a live player", async () => {
    const service = new CoCService();
    (service as any).playersApi = {
      getPlayer: vi.fn().mockResolvedValue({
        data: {
          tag: "#ABC123",
          name: "Modern Player",
          trophies: 0,
          leagueTier: { id: 105000034, name: "Legend III" },
          league: { name: "Legend League" },
          builderBaseTrophies: 4321,
          versusTrophies: 1234,
          clanCapitalContributions: 77,
        },
      }),
    };

    const player = await runWithCoCQueueContext(
      { priority: "interactive", source: "test" },
      async () => service.getPlayerRaw("#ABC123"),
    );

    expect(player).toMatchObject({
      tag: "#ABC123",
      name: "Modern Player",
      trophies: 0,
      leagueTier: { id: 105000034, name: "Legend III" },
      league: { name: "Legend League" },
      builderBaseTrophies: 4321,
      clanCapitalContributions: 77,
    });
  });

  it("aborts a stalled queued raid-season request and reports a timeout", async () => {
    vi.useFakeTimers();
    process.env.COC_API_REQUEST_TIMEOUT_MS = "1000";
    const axiosGet = vi.spyOn(axios, "get").mockImplementation(((_url, config) =>
      new Promise((_resolve, reject) => {
        config?.signal?.addEventListener("abort", () => {
          const error = Object.assign(new Error("canceled"), { code: "ERR_CANCELED" });
          reject(error);
        });
      })) as typeof axios.get);
    const service = new CoCService();

    const pending = runWithCoCQueueContext(
      { priority: "interactive", source: "test" },
      () => service.getClanCapitalRaidSeasons("#ABC123"),
    );
    const rejection = expect(pending).rejects.toMatchObject({
      code: "ETIMEDOUT",
      timeout: true,
    });
    await vi.advanceTimersByTimeAsync(1000);

    await rejection;
    expect(axiosGet).toHaveBeenCalledWith(
      expect.stringContaining("/clans/%23ABC123/capitalraidseasons"),
      expect.objectContaining({ timeout: 1000, signal: expect.any(AbortSignal) }),
    );
  });
});
