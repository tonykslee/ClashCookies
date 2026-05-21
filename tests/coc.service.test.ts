import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
});
