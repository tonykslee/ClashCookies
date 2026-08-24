import { afterEach, describe, expect, it, vi } from "vitest";
import { dozzleLog } from "../src/helper/dozzleLogger";
import { FwaWeightAlertDeliveryService } from "../src/services/FwaWeightAlertDeliveryService";

afterEach(() => {
  vi.restoreAllMocks();
});

function makeDb(input: {
  config?: Array<{ clanTag: string; thresholdDays: number; enabled?: boolean }>;
  catalog?: Array<{ clanTag: string; name: string | null; weightSubmitDate: Date | null }>;
  tracked?: Array<{
    tag: string;
    name: string | null;
    leaderChannelId: string | null;
    leadRoleId: string | null;
  }>;
  deliveries?: Array<{
    id: string;
    clanTag: string;
    weightSubmitDate: Date;
    status: "CLAIMED" | "SENT" | "FAILED";
    claimToken?: string | null;
    claimedAt?: Date | null;
    attemptCount?: number;
    discordMessageId?: string | null;
  }>;
}) {
  const rows: any[] = (input.deliveries ?? []).map((row) => ({
    claimToken: null,
    claimedAt: null,
    attemptCount: 0,
    discordMessageId: null,
    ...row,
  }));
  const db: any = {
    fwaWeightAlertConfig: {
      findMany: vi.fn(async () => (input.config ?? []).filter((config) => config.enabled !== false)),
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
    const { db, rows } = makeDb({
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
    const deliveryLog = vi.spyOn(dozzleLog, "info").mockImplementation(() => undefined);

    const first = await service.evaluateAndDeliver({ client, now: exactThreshold });
    const second = await service.evaluateAndDeliver({ client, now: exactThreshold });

    expect(first.counts.sentCount).toBe(1);
    expect(second.counts.alreadySentCount).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      content: expect.stringContaining("Alert threshold: **7 days**"),
      allowedMentions: { parse: [], roles: ["role-1"] },
    });
    expect(rows[0].discordMessageId).toBe("message-1");
    expect(deliveryLog.mock.calls.some(([line]) =>
      String(line).includes("[fwa-weight-alert] delivery_sent clan=#ABC123 channel=channel-1 message_id=message-1"),
    )).toBe(true);
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

  it("does not evaluate disabled or absent configuration", async () => {
    const { db, rows } = makeDb({
      config: [{ clanTag: "#ABC123", thresholdDays: 7, enabled: false }],
      catalog: [{ clanTag: "#ABC123", name: "Alpha", weightSubmitDate: submittedAt }],
      tracked: [{ tag: "#ABC123", name: "Alpha", leaderChannelId: "channel-1", leadRoleId: "role-1" }],
    });
    const send = vi.fn(async () => ({ id: "should-not-send" }));

    const result = await new FwaWeightAlertDeliveryService({ db } as any).evaluateAndDeliver({
      client: makeClient(send),
      now: exactThreshold,
    });

    expect(result.counts.evaluatedConfigCount).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(rows).toHaveLength(0);
  });

  it("skips null, missing, and future submission dates without creating episodes", async () => {
    const { db, rows } = makeDb({
      config: [
        { clanTag: "#ABC123", thresholdDays: 7 },
        { clanTag: "#DEF456", thresholdDays: 7 },
        { clanTag: "#GHI789", thresholdDays: 7 },
      ],
      catalog: [
        { clanTag: "#ABC123", name: "Null", weightSubmitDate: null },
        { clanTag: "#GHI789", name: "Future", weightSubmitDate: new Date("2026-01-09T00:00:00.000Z") },
      ],
      tracked: [
        { tag: "#ABC123", name: "Null", leaderChannelId: "channel-1", leadRoleId: "role-1" },
        { tag: "#DEF456", name: "Missing", leaderChannelId: "channel-2", leadRoleId: "role-2" },
        { tag: "#GHI789", name: "Future", leaderChannelId: "channel-3", leadRoleId: "role-3" },
      ],
    });
    const send = vi.fn(async () => ({ id: "should-not-send" }));

    const result = await new FwaWeightAlertDeliveryService({ db } as any).evaluateAndDeliver({
      client: makeClient(send),
      now: exactThreshold,
    });

    expect(result.counts.missingDateCount).toBe(2);
    expect(result.counts.invalidDateCount).toBe(1);
    expect(send).not.toHaveBeenCalled();
    expect(rows).toHaveLength(0);
  });

  it("reports each missing routing component only for due alerts", async () => {
    const { db, rows } = makeDb({
      config: [
        { clanTag: "#ABC123", thresholdDays: 7 },
        { clanTag: "#DEF456", thresholdDays: 7 },
        { clanTag: "#GHI789", thresholdDays: 7 },
      ],
      catalog: [
        { clanTag: "#ABC123", name: "Channel Missing", weightSubmitDate: submittedAt },
        { clanTag: "#DEF456", name: "Role Missing", weightSubmitDate: submittedAt },
        { clanTag: "#GHI789", name: "Both Missing", weightSubmitDate: submittedAt },
      ],
      tracked: [
        { tag: "#ABC123", name: "Channel Missing", leaderChannelId: null, leadRoleId: "role-1" },
        { tag: "#DEF456", name: "Role Missing", leaderChannelId: "channel-2", leadRoleId: null },
        { tag: "#GHI789", name: "Both Missing", leaderChannelId: null, leadRoleId: null },
      ],
    });
    const send = vi.fn(async () => ({ id: "should-not-send" }));
    const routingLog = vi.spyOn(dozzleLog, "warn").mockImplementation(() => undefined);

    const result = await new FwaWeightAlertDeliveryService({ db } as any).evaluateAndDeliver({
      client: makeClient(send),
      now: exactThreshold,
    });

    expect(result.counts.missingRoutingCount).toBe(3);
    expect(send).not.toHaveBeenCalled();
    expect(rows).toHaveLength(0);
    expect(routingLog.mock.calls).toEqual(expect.arrayContaining([
      ["[fwa-weight-alert] routing_missing clan=#ABC123 missing=leader_channel"],
      ["[fwa-weight-alert] routing_missing clan=#DEF456 missing=lead_role"],
      ["[fwa-weight-alert] routing_missing clan=#GHI789 missing=leader_channel,lead_role"],
    ]));
  });

  it("does not duplicate a recent claimed episode", async () => {
    const { db, rows } = makeDb({
      config: [{ clanTag: "#ABC123", thresholdDays: 7 }],
      catalog: [{ clanTag: "#ABC123", name: "Alpha", weightSubmitDate: submittedAt }],
      tracked: [{ tag: "#ABC123", name: "Alpha", leaderChannelId: "channel-1", leadRoleId: "role-1" }],
      deliveries: [{
        id: "delivery-1",
        clanTag: "#ABC123",
        weightSubmitDate: submittedAt,
        status: "CLAIMED",
        claimToken: "existing-claim",
        claimedAt: new Date("2026-01-07T23:59:00.000Z"),
        attemptCount: 1,
      }],
    });
    const send = vi.fn(async () => ({ id: "should-not-send" }));

    const result = await new FwaWeightAlertDeliveryService({ db } as any).evaluateAndDeliver({
      client: makeClient(send),
      now: exactThreshold,
    });

    expect(result.counts.claimedRecentlyCount).toBe(1);
    expect(send).not.toHaveBeenCalled();
    expect(rows[0].status).toBe("CLAIMED");
  });

  it("reclaims stale claimed episodes and counts recovery as a retry", async () => {
    const { db, rows } = makeDb({
      config: [{ clanTag: "#ABC123", thresholdDays: 7 }],
      catalog: [{ clanTag: "#ABC123", name: "Alpha", weightSubmitDate: submittedAt }],
      tracked: [{ tag: "#ABC123", name: "Alpha", leaderChannelId: "channel-1", leadRoleId: "role-1" }],
      deliveries: [{
        id: "delivery-1",
        clanTag: "#ABC123",
        weightSubmitDate: submittedAt,
        status: "CLAIMED",
        claimToken: "stale-claim",
        claimedAt: new Date("2026-01-07T23:54:00.000Z"),
        attemptCount: 1,
      }],
    });
    const send = vi.fn(async () => ({ id: "message-reclaimed" }));

    const result = await new FwaWeightAlertDeliveryService({ db, randomUUID: () => "new-claim" } as any).evaluateAndDeliver({
      client: makeClient(send),
      now: exactThreshold,
    });

    expect(result.counts.retryCount).toBe(1);
    expect(result.counts.sentCount).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "SENT", attemptCount: 2, discordMessageId: "message-reclaimed" });
  });

  it("reclaims a claimed episode with no claim timestamp as a retry", async () => {
    const { db, rows } = makeDb({
      config: [{ clanTag: "#ABC123", thresholdDays: 7 }],
      catalog: [{ clanTag: "#ABC123", name: "Alpha", weightSubmitDate: submittedAt }],
      tracked: [{ tag: "#ABC123", name: "Alpha", leaderChannelId: "channel-1", leadRoleId: "role-1" }],
      deliveries: [{
        id: "delivery-null-claim",
        clanTag: "#ABC123",
        weightSubmitDate: submittedAt,
        status: "CLAIMED",
        claimToken: "claim-without-time",
        claimedAt: null,
        attemptCount: 2,
      }],
    });
    const send = vi.fn(async () => ({ id: "message-null-claim" }));

    const result = await new FwaWeightAlertDeliveryService({ db } as any).evaluateAndDeliver({
      client: makeClient(send),
      now: exactThreshold,
    });

    expect(result.counts.retryCount).toBe(1);
    expect(result.counts.sentCount).toBe(1);
    expect(rows[0]).toMatchObject({ status: "SENT", attemptCount: 3 });
  });

  it("keeps SENT terminal for one date and creates a new episode for a new date", async () => {
    const newSubmissionDate = new Date("2026-01-02T00:00:00.000Z");
    const { db, rows } = makeDb({
      config: [{ clanTag: "#ABC123", thresholdDays: 1 }],
      catalog: [{ clanTag: "#ABC123", name: "Alpha", weightSubmitDate: newSubmissionDate }],
      tracked: [{ tag: "#ABC123", name: "Alpha", leaderChannelId: "channel-1", leadRoleId: "role-1" }],
      deliveries: [{
        id: "delivery-old",
        clanTag: "#ABC123",
        weightSubmitDate: submittedAt,
        status: "SENT",
        claimToken: "old-claim",
        claimedAt: submittedAt,
        attemptCount: 1,
        discordMessageId: "old-message",
      }],
    });
    const send = vi.fn(async () => ({ id: "new-message" }));

    const result = await new FwaWeightAlertDeliveryService({ db } as any).evaluateAndDeliver({
      client: makeClient(send),
      now: exactThreshold,
    });

    expect(result.counts.sentCount).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(2);
    expect(rows[0].status).toBe("SENT");
    expect(rows[1]).toMatchObject({ status: "SENT", discordMessageId: "new-message" });

    const sameDateDb = makeDb({
      config: [{ clanTag: "#ABC123", thresholdDays: 1 }],
      catalog: [{ clanTag: "#ABC123", name: "Alpha", weightSubmitDate: submittedAt }],
      tracked: [{ tag: "#ABC123", name: "Alpha", leaderChannelId: "channel-1", leadRoleId: "role-1" }],
      deliveries: [{
        id: "delivery-sent",
        clanTag: "#ABC123",
        weightSubmitDate: submittedAt,
        status: "SENT",
        discordMessageId: "already-sent",
      }],
    });
    const sameDateSend = vi.fn(async () => ({ id: "should-not-send" }));
    const sameDateResult = await new FwaWeightAlertDeliveryService({ db: sameDateDb.db } as any).evaluateAndDeliver({
      client: makeClient(sameDateSend),
      now: exactThreshold,
    });
    expect(sameDateResult.counts.alreadySentCount).toBe(1);
    expect(sameDateSend).not.toHaveBeenCalled();
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
