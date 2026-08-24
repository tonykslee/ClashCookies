import { describe, expect, it, vi } from "vitest";
import { FwaWeightAlertDeliveryService } from "../src/services/FwaWeightAlertDeliveryService";

function makeDb(input: {
  config?: Array<{ clanTag: string; thresholdDays: number }>;
  catalog?: Array<{ clanTag: string; name: string | null; weightSubmitDate: Date | null }>;
  tracked?: Array<{
    tag: string;
    name: string | null;
    leaderChannelId: string | null;
    leadRoleId: string | null;
  }>;
}) {
  const rows: any[] = [];
  const db: any = {
    fwaWeightAlertConfig: {
      findMany: vi.fn(async () => input.config ?? []),
    },
    fwaClanCatalog: {
      findMany: vi.fn(async () => input.catalog ?? []),
    },
    trackedClan: {
      findMany: vi.fn(async () => input.tracked ?? []),
    },
    fwaWeightAlertDelivery: {
      findUnique: vi.fn(async ({ where }: any) =>
        rows.find(
          (row) =>
            row.clanTag === where.clanTag_weightSubmitDate.clanTag &&
            row.weightSubmitDate.getTime() ===
              where.clanTag_weightSubmitDate.weightSubmitDate.getTime(),
        ) ?? null,
      ),
      create: vi.fn(async ({ data }: any) => {
        const row = { id: `delivery-${rows.length + 1}`, ...data };
        rows.push(row);
        return row;
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const matches = rows.filter((row) => {
          if (where.id && row.id !== where.id) return false;
          if (where.status && row.status !== where.status) return false;
          if (where.claimToken && row.claimToken !== where.claimToken) return false;
          if (!where.OR) return true;
          return where.OR.some((candidate: any) => {
            if (candidate.status !== row.status) return false;
            if (!("claimedAt" in candidate)) return true;
            if (candidate.claimedAt === null) return row.claimedAt === null;
            const cutoff = candidate.claimedAt?.lte;
            return cutoff instanceof Date && row.claimedAt instanceof Date
              ? row.claimedAt.getTime() <= cutoff.getTime()
              : false;
          });
        });
        for (const row of matches) {
          for (const [key, value] of Object.entries(data)) {
            row[key] =
              typeof value === "object" && value !== null && "increment" in value
                ? row[key] + Number((value as { increment: number }).increment)
                : value;
          }
        }
        return { count: matches.length };
      }),
    },
    $transaction: async (callback: (tx: any) => Promise<unknown>) => callback(db),
  };
  return { db, rows };
}

function makeClient(send: ReturnType<typeof vi.fn>) {
  return {
    channels: {
      fetch: vi.fn(async () => ({
        isTextBased: () => true,
        send,
      })),
    },
  } as any;
}

describe("FwaWeightAlertDeliveryService", () => {
  const submittedAt = new Date("2026-01-01T00:00:00.000Z");
  const exactThreshold = new Date("2026-01-08T00:00:00.000Z");

  it("sends at the exact threshold and remains idempotent for the same date", async () => {
    const { db } = makeDb({
      config: [{ clanTag: "#ABC123", thresholdDays: 7 }],
      catalog: [{ clanTag: "#ABC123", name: "Alpha", weightSubmitDate: submittedAt }],
      tracked: [{
        tag: "#ABC123",
        name: "Alpha",
        leaderChannelId: "channel-1",
        leadRoleId: "role-1",
      }],
    });
    const send = vi.fn(async () => ({ id: "message-1" }));
    const client = makeClient(send);
    const service = new FwaWeightAlertDeliveryService({
      db,
      randomUUID: () => "claim-1",
    } as any);

    const first = await service.evaluateAndDeliver({ client, now: exactThreshold });
    const second = await service.evaluateAndDeliver({ client, now: exactThreshold });

    expect(first.counts.sentCount).toBe(1);
    expect(second.counts.alreadySentCount).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      content: expect.stringContaining("Alert threshold: **7 days**"),
      allowedMentions: { parse: [], roles: ["role-1"] },
    });
  });

  it("records a failed send and retries the same episode", async () => {
    const { db } = makeDb({
      config: [{ clanTag: "#ABC123", thresholdDays: 7 }],
      catalog: [{ clanTag: "#ABC123", name: "Alpha", weightSubmitDate: submittedAt }],
      tracked: [{
        tag: "#ABC123",
        name: "Alpha",
        leaderChannelId: "channel-1",
        leadRoleId: "role-1",
      }],
    });
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error("Discord unavailable"))
      .mockResolvedValueOnce({ id: "message-2" });
    const service = new FwaWeightAlertDeliveryService({
      db,
      randomUUID: (() => {
        let count = 0;
        return () => `claim-${++count}`;
      })(),
    } as any);

    const first = await service.evaluateAndDeliver({ client: makeClient(send), now: exactThreshold });
    const second = await service.evaluateAndDeliver({ client: makeClient(send), now: exactThreshold });

    expect(first.counts.failedCount).toBe(1);
    expect(second.counts.retryCount).toBe(1);
    expect(second.counts.sentCount).toBe(1);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("does not send when routing is incomplete or the episode is not due", async () => {
    const { db } = makeDb({
      config: [
        { clanTag: "#ABC123", thresholdDays: 7 },
        { clanTag: "#DEF456", thresholdDays: 7 },
      ],
      catalog: [
        { clanTag: "#ABC123", name: "Alpha", weightSubmitDate: submittedAt },
        { clanTag: "#DEF456", name: "Beta", weightSubmitDate: new Date("2026-01-07T00:00:00.000Z") },
      ],
      tracked: [
        { tag: "#ABC123", name: "Alpha", leaderChannelId: null, leadRoleId: "role-1" },
        { tag: "#DEF456", name: "Beta", leaderChannelId: "channel-2", leadRoleId: "role-2" },
      ],
    });
    const send = vi.fn(async () => ({ id: "message-3" }));
    const result = await new FwaWeightAlertDeliveryService({ db } as any).evaluateAndDeliver({
      client: makeClient(send),
      now: exactThreshold,
    });

    expect(result.counts.missingRoutingCount).toBe(1);
    expect(result.counts.notDueCount).toBe(1);
    expect(send).not.toHaveBeenCalled();
  });

  it("skips mirror evaluation without reading or sending", async () => {
    const { db } = makeDb({ config: [{ clanTag: "#ABC123", thresholdDays: 7 }] });
    const result = await new FwaWeightAlertDeliveryService({ db } as any).evaluateAndDeliver({
      client: makeClient(vi.fn()),
      pollingMode: "mirror",
      now: exactThreshold,
    });

    expect(result.skippedReason).toBe("mirror_or_staging");
    expect(db.fwaWeightAlertConfig.findMany).not.toHaveBeenCalled();
  });
});
