import { afterEach, describe, expect, it, vi } from "vitest";
import { LayoutAlertMode } from "@prisma/client";
import { LayoutAlertDeliveryService } from "../src/services/LayoutAlertDeliveryService";

const LINK = "https://link.clashofclans.com/en?action=OpenLayout&id=TH18%3ARISINGDAWN%3Aabc123";
const ANCHOR = new Date("2026-01-01T00:00:00.000Z");
const DUE = new Date("2026-01-29T00:00:00.000Z");

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
    const { db } = makeDb();
    const channelSend = vi.fn(async () => ({ id: "message-1" }));
    const service = new LayoutAlertDeliveryService({
      db,
      randomUUID: () => "claim-1",
      botLogChannelService: { getChannelIdForType: vi.fn(async () => "alert-channel") },
    } as any);

    const result = await service.evaluateAndDeliver({ client: makeClient({ channelSend }), now: DUE });

    expect(result.counts.sent).toBe(1);
    expect(channelSend).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining("https://discord.com/channels/guild-1/post-channel/post-message"),
    }));
    expect(channelSend.mock.calls[0]?.[0].content).not.toContain(LINK);
  });

  it("does not create a delivery for unknown, future, or not-yet-due freshness", async () => {
    for (const layout of [
      { submittedAt: null, lastConfirmedAt: null },
      { submittedAt: new Date("2026-02-01T00:00:00.000Z"), lastConfirmedAt: null },
      { submittedAt: new Date("2026-01-02T00:00:00.000Z"), lastConfirmedAt: null },
    ]) {
      const { db, rows } = makeDb({ layout });
      const result = await new LayoutAlertDeliveryService({ db } as any).evaluateAndDeliver({
        client: makeClient({}),
        now: DUE,
      });
      expect(rows).toHaveLength(0);
      expect(result.counts.sent).toBe(0);
    }
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

    const result = await service.evaluateAndDeliver({ client: makeClient({ dmSend, channelSend }), now: DUE });

    expect(result.counts.failed).toBe(1);
    expect(result.counts.sent).toBe(1);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.target).sort()).toEqual(["CHANNEL", "DM"]);
  });

  it("resolves default routing from the canonical guild and has no fallback", async () => {
    const { db, layout } = makeDb();
    layout.discordGuildId = "canonical-guild";
    const getChannelIdForType = vi.fn(async (guildId: string) => guildId === "canonical-guild" ? "canonical-alerts" : null);
    const service = new LayoutAlertDeliveryService({
      db,
      botLogChannelService: { getChannelIdForType },
    } as any);

    await service.evaluateAndDeliver({ client: makeClient({ channelGuildId: "canonical-guild" }), now: DUE });

    expect(getChannelIdForType).toHaveBeenCalledWith("canonical-guild", "layout-alerts");
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

    const first = await service.evaluateAndDeliver({ client, now: DUE });
    const deferred = await service.evaluateAndDeliver({ client, now: new Date(DUE.getTime() + 1) });
    const retried = await service.evaluateAndDeliver({ client, now: new Date(DUE.getTime() + 6 * 60 * 60 * 1000) });

    expect(first.counts.failed).toBe(1);
    expect(deferred.counts.retryDeferred).toBe(1);
    expect(retried.counts.sent).toBe(1);
  });

  it("supersedes a claimed episode when the freshness anchor changes before send", async () => {
    const { db, layout, rows } = makeDb();
    db.layoutRecord.findUnique.mockImplementation(async () => ({ ...layout, lastConfirmedAt: new Date("2026-01-02T00:00:00.000Z") }));
    const channelSend = vi.fn();
    const service = new LayoutAlertDeliveryService({
      db,
      botLogChannelService: { getChannelIdForType: vi.fn(async () => "alert-channel") },
    } as any);

    const result = await service.evaluateAndDeliver({ client: makeClient({ channelSend }), now: DUE });

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

  it("treats a delivery uniqueness race as contention instead of failing the cycle", async () => {
    const { db } = makeDb({ createError: { code: "P2002" } });
    const result = await new LayoutAlertDeliveryService({ db } as any).evaluateAndDeliver({
      client: makeClient({}),
      now: DUE,
    });

    expect(result.counts.claimed).toBe(0);
    expect(result.counts.failed).toBe(0);
    expect(result.counts.skipped).toBe(0);
  });
});
