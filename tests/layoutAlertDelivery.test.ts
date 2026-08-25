import { afterEach, describe, expect, it, vi } from "vitest";
import { LayoutAlertMode } from "@prisma/client";
import { LayoutAlertDeliveryService } from "../src/services/LayoutAlertDeliveryService";

const LINK = "https://link.clashofclans.com/en?action=OpenLayout&id=TH18%3ARISINGDAWN%3Aabc123";
const ANCHOR = new Date("2026-01-01T00:00:00.000Z");
const DUE = new Date("2026-01-29T00:00:00.000Z");
const ACTIVE_PROD = { pollingMode: "active" as const, runtimeEnvironment: "prod" as const };

function makeDb(input: {
  mode?: LayoutAlertMode;
  customChannelId?: string | null;
  layout?: Partial<any>;
  deliveries?: Array<Partial<any>>;
  createError?: unknown;
} = {}) {
  const layout = {
    id: "layout-1",
    layoutLink: LINK,
    title: "",
    lastConfirmedAt: null,
    submittedAt: ANCHOR,
    postedByDiscordUserId: "user-1",
    discordGuildId: "guild-1",
    discordChannelId: "post-channel",
    discordMessageId: "post-message",
    ...(input.layout ?? {}),
  };
  const configs: any[] = [{
    layoutId: layout.id,
    mode: input.mode ?? LayoutAlertMode.DEFAULT_CHANNEL,
    customChannelId: input.customChannelId ?? null,
    layout,
  }];
  const rows: any[] = (input.deliveries ?? []).map((row, index) => ({
    id: `delivery-${index + 1}`,
    status: "SENT",
    claimToken: null,
    claimedAt: null,
    lastAttemptAt: null,
    attemptCount: 1,
    ...row,
  }));
  const db: any = {
    layoutAlertConfig: {
      findMany: vi.fn(async () => configs),
      findUnique: vi.fn(async () => configs[0] ?? null),
    },
    layoutRecord: {
      findUnique: vi.fn(async () => layout),
    },
    layoutAlertDelivery: {
      findUnique: vi.fn(async ({ where }: any) => rows.find((row) =>
        row.layoutId === where.layoutId_freshnessAnchorAt_target.layoutId &&
        row.freshnessAnchorAt?.getTime() === where.layoutId_freshnessAnchorAt_target.freshnessAnchorAt.getTime() &&
        row.target === where.layoutId_freshnessAnchorAt_target.target,
      ) ?? null),
      create: vi.fn(async ({ data }: any) => {
        if (input.createError) throw input.createError;
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
            if (candidate.status && row.status !== candidate.status) return false;
            if (candidate.claimedAt?.lte && (!row.claimedAt || row.claimedAt > candidate.claimedAt.lte)) return false;
            if (candidate.claimedAt === null && row.claimedAt !== null) return false;
            if (candidate.lastAttemptAt?.lte && (!row.lastAttemptAt || row.lastAttemptAt > candidate.lastAttemptAt.lte)) return false;
            if (candidate.lastAttemptAt === null && row.lastAttemptAt !== null) return false;
            return true;
          });
        });
        for (const row of matches) {
          for (const [key, value] of Object.entries(data)) {
            row[key] = typeof value === "object" && value !== null && "increment" in value
              ? row[key] + Number((value as { increment: number }).increment)
              : value;
          }
        }
        return { count: matches.length };
      }),
    },
    $transaction: async (callback: (tx: any) => Promise<unknown>) => callback(db),
  };
  return { db, layout, configs, rows };
}

function makeClient(input: {
  channelSend?: ReturnType<typeof vi.fn>;
  dmSend?: ReturnType<typeof vi.fn>;
  channelGuildId?: string;
}) {
  const channelSend = input.channelSend ?? vi.fn(async () => ({ id: "channel-message" }));
  const dmSend = input.dmSend ?? vi.fn(async () => ({ id: "dm-message" }));
  return {
    channels: { fetch: vi.fn(async () => ({
      guildId: input.channelGuildId ?? "guild-1",
      isTextBased: () => true,
      send: channelSend,
    })) },
    users: { fetch: vi.fn(async () => ({ send: dmSend })) },
  } as any;
}

afterEach(() => vi.restoreAllMocks());

describe("LayoutAlertDeliveryService", () => {
  it("is due inclusively at 28 days and sends a canonical jump link without the Clash URL", async () => {
    const { db, rows } = makeDb();
    const channelSend = vi.fn(async () => ({ id: "message-1" }));
    const service = new LayoutAlertDeliveryService({
      db,
      randomUUID: () => "claim-1",
      botLogChannelService: { getChannelIdForType: vi.fn(async () => "alert-channel") },
    } as any);

    const result = await service.evaluateAndDeliver({ ...ACTIVE_PROD, client: makeClient({ channelSend }), now: DUE });

    expect(result.counts.sent).toBe(1);
    expect(channelSend).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining("https://discord.com/channels/guild-1/post-channel/post-message"),
    }));
    expect(channelSend.mock.calls[0]?.[0].content).not.toContain(LINK);
    expect(rows[0]).toMatchObject({ status: "SENT", destinationId: "alert-channel" });
  });

  it("does not create a delivery for unknown, future, or not-yet-due freshness", async () => {
    for (const layout of [
      { submittedAt: null, lastConfirmedAt: null },
      { submittedAt: new Date("2026-02-01T00:00:00.000Z"), lastConfirmedAt: null },
      { submittedAt: new Date("2026-01-02T00:00:00.000Z"), lastConfirmedAt: null },
    ]) {
      const { db, rows } = makeDb({ layout });
      const result = await new LayoutAlertDeliveryService({ db } as any).evaluateAndDeliver({
        ...ACTIVE_PROD,
        client: makeClient({}),
        now: DUE,
      });
      expect(rows).toHaveLength(0);
      expect(result.counts.sent).toBe(0);
    }
  });

  it("uses lastConfirmedAt when submittedAt is null and gives it authority over submittedAt", async () => {
    const { db, rows } = makeDb({
      layout: {
        submittedAt: null,
        lastConfirmedAt: ANCHOR,
      },
    });
    const channelSend = vi.fn(async () => ({ id: "confirmed-message" }));
    const service = new LayoutAlertDeliveryService({
      db,
      botLogChannelService: { getChannelIdForType: vi.fn(async () => "alert-channel") },
    } as any);

    await service.evaluateAndDeliver({ ...ACTIVE_PROD, client: makeClient({ channelSend }), now: DUE });

    expect(rows[0]).toMatchObject({ status: "SENT" });
    expect(channelSend).toHaveBeenCalledTimes(1);
  });

  it("expands BOTH into independent targets and allows one target to fail", async () => {
    const { db, rows } = makeDb({ mode: LayoutAlertMode.BOTH });
    const dmSend = vi.fn().mockRejectedValue(new Error("DM unavailable"));
    const channelSend = vi.fn(async () => ({ id: "channel-message" }));
    const service = new LayoutAlertDeliveryService({
      db,
      randomUUID: (() => {
        let count = 0;
        return () => `claim-${++count}`;
      })(),
      botLogChannelService: { getChannelIdForType: vi.fn(async () => "alert-channel") },
    } as any);

    const result = await service.evaluateAndDeliver({ ...ACTIVE_PROD, client: makeClient({ dmSend, channelSend }), now: DUE });

    expect(result.counts.failed).toBe(1);
    expect(result.counts.sent).toBe(1);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.target).sort()).toEqual(["CHANNEL", "DM"]);
  });

  it("dedupes the successful BOTH target while deferring and later retrying the failed target", async () => {
    const { db, rows } = makeDb({ mode: LayoutAlertMode.BOTH });
    const dmSend = vi.fn(async () => ({ id: "dm-message" }));
    const channelSend = vi.fn().mockRejectedValueOnce(new Error("channel unavailable")).mockResolvedValueOnce({ id: "channel-retry" });
    const service = new LayoutAlertDeliveryService({
      db,
      botLogChannelService: { getChannelIdForType: vi.fn(async () => "alert-channel") },
    } as any);
    const client = makeClient({ dmSend, channelSend });

    const first = await service.evaluateAndDeliver({ ...ACTIVE_PROD, client, now: DUE });
    const deferred = await service.evaluateAndDeliver({ ...ACTIVE_PROD, client, now: new Date(DUE.getTime() + 1) });
    const retried = await service.evaluateAndDeliver({ ...ACTIVE_PROD, client, now: new Date(DUE.getTime() + 6 * 60 * 60 * 1000) });

    expect(first.counts.sent).toBe(1);
    expect(first.counts.failed).toBe(1);
    expect(deferred.counts.deduped).toBe(1);
    expect(deferred.counts.retryDeferred).toBe(1);
    expect(retried.counts.deduped).toBe(1);
    expect(retried.counts.sent).toBe(1);
    expect(dmSend).toHaveBeenCalledTimes(1);
    expect(channelSend).toHaveBeenCalledTimes(2);
    expect(rows.every((row) => row.status === "SENT")).toBe(true);
  });

  it("supports the reverse BOTH-target failure direction", async () => {
    const { db } = makeDb({ mode: LayoutAlertMode.BOTH });
    const dmSend = vi.fn().mockRejectedValueOnce(new Error("DM unavailable")).mockResolvedValueOnce({ id: "dm-retry" });
    const channelSend = vi.fn(async () => ({ id: "channel-message" }));
    const service = new LayoutAlertDeliveryService({
      db,
      botLogChannelService: { getChannelIdForType: vi.fn(async () => "alert-channel") },
    } as any);
    const client = makeClient({ dmSend, channelSend });

    await service.evaluateAndDeliver({ ...ACTIVE_PROD, client, now: DUE });
    const deferred = await service.evaluateAndDeliver({ ...ACTIVE_PROD, client, now: new Date(DUE.getTime() + 1) });
    const retried = await service.evaluateAndDeliver({ ...ACTIVE_PROD, client, now: new Date(DUE.getTime() + 6 * 60 * 60 * 1000) });

    expect(deferred.counts.deduped).toBe(1);
    expect(deferred.counts.retryDeferred).toBe(1);
    expect(retried.counts.deduped).toBe(1);
    expect(retried.counts.sent).toBe(1);
    expect(dmSend).toHaveBeenCalledTimes(2);
    expect(channelSend).toHaveBeenCalledTimes(1);
  });

  it("resolves default routing from the canonical guild and has no fallback", async () => {
    const { db, layout } = makeDb();
    layout.discordGuildId = "canonical-guild";
    const getChannelIdForType = vi.fn(async (guildId: string) => guildId === "canonical-guild" ? "canonical-alerts" : null);
    const service = new LayoutAlertDeliveryService({
      db,
      botLogChannelService: { getChannelIdForType },
    } as any);

    await service.evaluateAndDeliver({ ...ACTIVE_PROD, client: makeClient({ channelGuildId: "canonical-guild" }), now: DUE });

    expect(getChannelIdForType).toHaveBeenCalledWith("canonical-guild", "layout-alerts");
  });

  it("retains a known DM destination when user fetch fails", async () => {
    const { db, rows } = makeDb({ mode: LayoutAlertMode.DM });
    const client = makeClient({});
    client.users.fetch.mockRejectedValue(new Error("user unavailable"));
    const service = new LayoutAlertDeliveryService({ db } as any);

    await service.evaluateAndDeliver({ ...ACTIVE_PROD, client, now: DUE });

    expect(rows[0]).toMatchObject({ status: "FAILED", destinationId: "user-1" });
  });

  it("retains a known default-channel destination when channel fetch fails", async () => {
    const { db, rows } = makeDb();
    const client = makeClient({});
    client.channels.fetch.mockResolvedValue(null);
    const service = new LayoutAlertDeliveryService({
      db,
      botLogChannelService: { getChannelIdForType: vi.fn(async () => "default-alerts") },
    } as any);

    await service.evaluateAndDeliver({ ...ACTIVE_PROD, client, now: DUE });

    expect(rows[0]).toMatchObject({ status: "FAILED", destinationId: "default-alerts" });
  });

  it("retains a known custom-channel destination when the fetched channel is invalid", async () => {
    const { db, rows } = makeDb({ mode: LayoutAlertMode.CUSTOM_CHANNEL, customChannelId: "custom-alerts" });
    const client = makeClient({ channelGuildId: "other-guild" });
    const service = new LayoutAlertDeliveryService({ db } as any);

    await service.evaluateAndDeliver({ ...ACTIVE_PROD, client, now: DUE });

    expect(rows[0]).toMatchObject({ status: "FAILED", destinationId: "custom-alerts" });
  });

  it("leaves destinationId null when default routing is genuinely missing", async () => {
    const { db, rows } = makeDb();
    const service = new LayoutAlertDeliveryService({
      db,
      botLogChannelService: { getChannelIdForType: vi.fn(async () => null) },
    } as any);

    await service.evaluateAndDeliver({ ...ACTIVE_PROD, client: makeClient({}), now: DUE });

    expect(rows[0]).toMatchObject({ status: "FAILED", destinationId: null, failureCode: "MISSING_DEFAULT_CHANNEL" });
  });

  it("retries a failed episode only after the six-hour delay", async () => {
    const { db } = makeDb();
    const channelSend = vi.fn().mockRejectedValueOnce(new Error("temporary")).mockResolvedValueOnce({ id: "recovered" });
    const service = new LayoutAlertDeliveryService({
      db,
      randomUUID: (() => {
        let count = 0;
        return () => `claim-${++count}`;
      })(),
      botLogChannelService: { getChannelIdForType: vi.fn(async () => "alert-channel") },
    } as any);
    const client = makeClient({ channelSend });

    const first = await service.evaluateAndDeliver({ ...ACTIVE_PROD, client, now: DUE });
    const deferred = await service.evaluateAndDeliver({ ...ACTIVE_PROD, client, now: new Date(DUE.getTime() + 1) });
    const retried = await service.evaluateAndDeliver({ ...ACTIVE_PROD, client, now: new Date(DUE.getTime() + 6 * 60 * 60 * 1000) });

    expect(first.counts.failed).toBe(1);
    expect(deferred.counts.retryDeferred).toBe(1);
    expect(retried.counts.sent).toBe(1);
  });

  it("does not steal a recent claim and reclaims a stale claim", async () => {
    const recent = makeDb({ deliveries: [{
      layoutId: "layout-1",
      freshnessAnchorAt: ANCHOR,
      target: "CHANNEL",
      status: "CLAIMED",
      claimToken: "recent",
      claimedAt: new Date(DUE.getTime() - 60_000),
      attemptCount: 1,
    }] });
    const recentSend = vi.fn();
    const recentResult = await new LayoutAlertDeliveryService({ db: recent.db } as any).evaluateAndDeliver({
      ...ACTIVE_PROD,
      client: makeClient({ channelSend: recentSend }),
      now: DUE,
    });
    expect(recentResult.counts.recentClaims).toBe(1);
    expect(recentSend).not.toHaveBeenCalled();

    const stale = makeDb({ deliveries: [{
      layoutId: "layout-1",
      freshnessAnchorAt: ANCHOR,
      target: "CHANNEL",
      status: "CLAIMED",
      claimToken: "stale",
      claimedAt: new Date(DUE.getTime() - 6 * 60_000),
      attemptCount: 1,
    }] });
    const staleSend = vi.fn(async () => ({ id: "reclaimed" }));
    const staleResult = await new LayoutAlertDeliveryService({
      db: stale.db,
      botLogChannelService: { getChannelIdForType: vi.fn(async () => "alert-channel") },
    } as any).evaluateAndDeliver({
      ...ACTIVE_PROD,
      client: makeClient({ channelSend: staleSend }),
      now: DUE,
    });
    expect(staleResult.counts.claimed).toBe(1);
    expect(staleResult.counts.sent).toBe(1);
    expect(stale.rows[0]).toMatchObject({ status: "SENT", attemptCount: 2 });
  });

  it("creates a new episode only after the freshness anchor changes", async () => {
    const { db, layout, rows } = makeDb();
    const send = vi.fn(async () => ({ id: `message-${send.mock.calls.length + 1}` }));
    const service = new LayoutAlertDeliveryService({
      db,
      botLogChannelService: { getChannelIdForType: vi.fn(async () => "alert-channel") },
    } as any);
    const client = makeClient({ channelSend: send });

    await service.evaluateAndDeliver({ ...ACTIVE_PROD, client, now: DUE });
    await service.evaluateAndDeliver({ ...ACTIVE_PROD, client, now: DUE });
    expect(send).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(1);

    layout.lastConfirmedAt = new Date("2026-02-01T00:00:00.000Z");
    await service.evaluateAndDeliver({ ...ACTIVE_PROD, client, now: new Date("2026-03-01T00:00:00.000Z") });
    expect(send).toHaveBeenCalledTimes(2);
    expect(rows).toHaveLength(2);
  });

  it("supersedes a claimed episode when the freshness anchor changes before send", async () => {
    const { db, layout, rows } = makeDb();
    db.layoutRecord.findUnique.mockImplementation(async () => ({ ...layout, lastConfirmedAt: new Date("2026-01-02T00:00:00.000Z") }));
    const channelSend = vi.fn();
    const service = new LayoutAlertDeliveryService({
      db,
      botLogChannelService: { getChannelIdForType: vi.fn(async () => "alert-channel") },
    } as any);

    const result = await service.evaluateAndDeliver({ ...ACTIVE_PROD, client: makeClient({ channelSend }), now: DUE });

    expect(result.counts.superseded).toBe(1);
    expect(channelSend).not.toHaveBeenCalled();
    expect(rows[0]).toMatchObject({ status: "SUPERSEDED" });
  });

  it("skips all reads and sends in mirror mode", async () => {
    const { db } = makeDb();
    const result = await new LayoutAlertDeliveryService({ db } as any).evaluateAndDeliver({
      client: makeClient({}),
      pollingMode: "mirror",
      now: DUE,
    });
    expect(result.skippedReason).toBe("mirror");
    expect(db.layoutAlertConfig.findMany).not.toHaveBeenCalled();
  });

  it.each([
    ["staging", "staging"],
    ["development", "non_production"],
    ["unknown", "non_production"],
  ] as const)("fails closed for active %s runtime", async (runtimeEnvironment, skippedReason) => {
    const { db } = makeDb();
    const result = await new LayoutAlertDeliveryService({ db } as any).evaluateAndDeliver({
      pollingMode: "active",
      runtimeEnvironment: runtimeEnvironment === "development" ? "dev" : runtimeEnvironment,
      client: makeClient({}),
      now: DUE,
    });

    expect(result.skippedReason).toBe(skippedReason);
    expect(db.layoutAlertConfig.findMany).not.toHaveBeenCalled();
  });

  it("treats a delivery uniqueness race as contention instead of failing the cycle", async () => {
    const { db } = makeDb({ createError: { code: "P2002" } });
    const result = await new LayoutAlertDeliveryService({ db } as any).evaluateAndDeliver({
      ...ACTIVE_PROD,
      client: makeClient({}),
      now: DUE,
    });

    expect(result.counts.claimed).toBe(0);
    expect(result.counts.failed).toBe(0);
    expect(result.counts.skipped).toBe(0);
  });
});
