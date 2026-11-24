import { ChannelType, PermissionFlagsBits } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { dozzleLog } from "../src/helper/dozzleLogger";
import {
  SYNC_ALL_SPUN_EVENT_TYPE,
  SYNC_ALL_SPUN_MESSAGE,
  SyncAllSpunAnnouncementService,
} from "../src/services/SyncAllSpunAnnouncementService";

const syncTime = new Date("2026-08-15T11:00:00.000Z");
const now = new Date("2026-08-15T12:00:00.000Z");

type TrackedRow = {
  id: string;
  guildId: string;
  messageId: string;
  referenceId: string | null;
  featureType: string;
  status: string;
  expiresAt: Date | null;
  createdAt: Date;
  metadata: any;
  claims: Array<{ clanTag: string; userId: string }>;
};

function metadata(overrides: Partial<any> = {}) {
  return {
    syncTimeIso: syncTime.toISOString(),
    syncEpochSeconds: Math.floor(syncTime.getTime() / 1000),
    roleId: "role-1",
    clans: [
      { clanTag: "#AAA111", clanName: "Alpha", code: "A", emojiId: null, emojiName: "🅰️", emojiInline: "🅰️" },
      { clanTag: "#BBB222", clanName: "Bravo", code: "B", emojiId: null, emojiName: "🅱️", emojiInline: "🅱️" },
    ],
    ...overrides,
  };
}

function makeRows(rootMetadata = metadata()): TrackedRow[] {
  return [
    {
      id: "root-id",
      guildId: "guild-1",
      messageId: "root-message",
      referenceId: null,
      featureType: "SYNC_TIME_POST",
      status: "ACTIVE",
      expiresAt: new Date("2026-08-15T13:00:00.000Z"),
      createdAt: new Date("2026-08-15T10:00:00.000Z"),
      metadata: rootMetadata,
      claims: [],
    },
    {
      id: "status-id",
      guildId: "guild-1",
      messageId: "status-message",
      referenceId: "root-message",
      featureType: "SYNC_TIME_POST",
      status: "ACTIVE",
      expiresAt: new Date("2026-08-15T13:00:00.000Z"),
      createdAt: new Date("2026-08-15T10:30:00.000Z"),
      metadata: rootMetadata,
      claims: [],
    },
  ];
}

function sameValue(left: unknown, right: unknown): boolean {
  if (left instanceof Date && right instanceof Date) return left.getTime() === right.getTime();
  return left === right;
}

function matchesWhere(row: Record<string, any>, where: any): boolean {
  if (!where) return true;
  if (where.OR && !where.OR.some((condition: any) => matchesWhere(row, condition))) return false;
  if (where.AND && !where.AND.every((condition: any) => matchesWhere(row, condition))) return false;
  return Object.entries(where).every(([key, expected]) => {
    if (key === "OR" || key === "AND") return true;
    if (key === "expiresAt" && expected && typeof expected === "object") {
      if ("gt" in expected) return row.expiresAt !== null && row.expiresAt.getTime() > expected.gt.getTime();
      if ("gte" in expected) return row.expiresAt !== null && row.expiresAt.getTime() >= expected.gte.getTime();
      return true;
    }
    return sameValue(row[key], expected);
  });
}

function makeDependencies(options: {
  rows?: TrackedRow[];
  send?: ReturnType<typeof vi.fn>;
  env?: NodeJS.ProcessEnv;
  clock?: () => Date;
} = {}) {
  const rows = options.rows ?? makeRows();
  const events = new Map<string, any>();
  const eventKey = (value: any) =>
    `${value.guildId}|${value.syncTime.toISOString()}|${value.clanTag}|${value.eventType}`;
  const syncEvent = {
    findFirst: vi.fn(async ({ where }: any) => events.get(eventKey(where)) ?? null),
    create: vi.fn(async ({ data }: any) => {
      const key = eventKey(data);
      if (events.has(key)) throw Object.assign(new Error("unique"), { code: "P2002" });
      const row = { ...data, createdAt: new Date("2026-08-15T12:01:00.000Z") };
      events.set(key, row);
      return { createdAt: row.createdAt };
    }),
    updateMany: vi.fn(async ({ where, data }: any) => {
      const row = events.get(eventKey(where));
      if (!row || row.createdAt.getTime() !== where.createdAt.getTime()) return { count: 0 };
      if (row.payload?.status !== "claimed") return { count: 0 };
      row.payload = data.payload;
      return { count: 1 };
    }),
    deleteMany: vi.fn(async ({ where }: any) => {
      const key = eventKey(where);
      const row = events.get(key);
      if (!row || (where.createdAt && row.createdAt.getTime() !== where.createdAt.getTime())) return { count: 0 };
      events.delete(key);
      return { count: 1 };
    }),
    findMany: vi.fn(async ({ where }: any) => [...events.values()].filter((row) => matchesWhere(row, where))),
  };
  const trackedMessage = {
    findUnique: vi.fn(async ({ where }: any) => rows.find((row) => row.messageId === where.messageId) ?? null),
    findFirst: vi.fn(async ({ where }: any) => [...rows]
      .filter((row) => matchesWhere(row, where))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null),
    findMany: vi.fn(async ({ where }: any) => rows.filter((row) => matchesWhere(row, where))),
  };
  const send = options.send ?? vi.fn().mockResolvedValue({ id: "announcement-1" });
  const channel = {
    guildId: "guild-1",
    type: ChannelType.GuildText,
    isTextBased: () => true,
    permissionsFor: vi.fn().mockReturnValue({
      has: vi.fn((permission: PermissionFlagsBits) => permission === PermissionFlagsBits.SendMessages),
    }),
    send,
  };
  const guild = {
    id: "guild-1",
    members: { me: { id: "bot-1" } },
    channels: { fetch: vi.fn().mockResolvedValue(channel) },
  };
  const client = {
    user: { id: "bot-1" },
    guilds: { fetch: vi.fn().mockResolvedValue(guild) },
  } as any;
  const routing = {
    getChannelIdForType: vi.fn().mockResolvedValue("channel-1"),
  };
  const db = { trackedMessage, syncEvent };
  const service = new SyncAllSpunAnnouncementService(
    routing as any,
    db as any,
    options.env ?? { POLLING_MODE: "active", DEPLOY_ENV: "prod" },
    options.clock ?? (() => new Date(now)),
  );
  return { rows, events, syncEvent, trackedMessage, client, guild, channel, send, routing, service };
}

describe("SyncAllSpunAnnouncementService", () => {
  it("completes from source-only claims and sends the exact plain-text message", async () => {
    const deps = makeDependencies();
    deps.rows[0].claims = [
      { clanTag: "#AAA111", userId: "user-a" },
      { clanTag: "#BBB222", userId: "user-b" },
    ];

    await expect(deps.service.evaluateAfterAdd(deps.client, "root-message", now))
      .resolves.toMatchObject({ state: "delivered", channelId: "channel-1" });
    expect(deps.send).toHaveBeenCalledWith(SYNC_ALL_SPUN_MESSAGE);
    expect(deps.events.get(`guild-1|${syncTime.toISOString()}||${SYNC_ALL_SPUN_EVENT_TYPE}`).payload)
      .toMatchObject({ status: "delivered", rootMessageId: "root-message", participatingClanCount: 2 });
  });

  it("aggregates status-only and mixed-post claims by normalized clan once", async () => {
    const statusOnly = makeDependencies();
    statusOnly.rows[1].claims = [
      { clanTag: "#aaa111", userId: "user-a" },
      { clanTag: "#BBB222", userId: "user-b" },
    ];
    await expect(statusOnly.service.evaluateAfterAdd(statusOnly.client, "status-message", now))
      .resolves.toMatchObject({ state: "delivered" });

    const mixed = makeDependencies();
    mixed.rows[0].claims = [
      { clanTag: "#AAA111", userId: "user-a" },
      { clanTag: "#AAA111", userId: "user-b" },
    ];
    mixed.rows[1].claims = [
      { clanTag: "#aaa111", userId: "user-c" },
      { clanTag: "#BBB222", userId: "user-d" },
    ];
    await expect(mixed.service.evaluateAfterAdd(mixed.client, "status-message", now))
      .resolves.toMatchObject({ state: "delivered" });
    expect(mixed.send).toHaveBeenCalledTimes(1);
  });

  it("requires every distinct participant in the canonical root snapshot", async () => {
    const threeClanMetadata = metadata({
      clans: [
        ...metadata().clans,
        { clanTag: "#CCC333", clanName: "Charlie", code: "C", emojiId: null, emojiName: "🆑", emojiInline: "🆑" },
      ],
    });
    const deps = makeDependencies({ rows: makeRows(threeClanMetadata) });
    deps.rows[0].claims = [
      { clanTag: "#AAA111", userId: "user-a" },
      { clanTag: "#BBB222", userId: "user-b" },
    ];

    await expect(deps.service.evaluateAfterAdd(deps.client, "root-message", now))
      .resolves.toMatchObject({ state: "incomplete", participatingClanCount: 3, claimedClanCount: 2 });
    expect(deps.send).not.toHaveBeenCalled();

    deps.rows[0].claims.push({ clanTag: "#CCC333", userId: "user-c" });
    await expect(deps.service.evaluateAfterAdd(deps.client, "root-message", now))
      .resolves.toMatchObject({ state: "delivered" });
  });

  it("allows a legitimate single-clan sync to complete at one of one", async () => {
    const single = makeDependencies({ rows: makeRows(metadata({ clans: [metadata().clans[0]] })) });
    single.rows[0].claims = [{ clanTag: "#AAA111", userId: "user-a" }];
    await expect(single.service.evaluateAfterAdd(single.client, "root-message", now))
      .resolves.toMatchObject({ state: "delivered" });
    expect(single.send).toHaveBeenCalledWith(SYNC_ALL_SPUN_MESSAGE);
  });

  it("rejects child claims whose persisted metadata does not match the canonical sync identity", async () => {
    const deps = makeDependencies();
    deps.rows[1].claims = [{ clanTag: "#BBB222", userId: "user-b" }];
    deps.rows[1].metadata = metadata({ clans: [metadata().clans[0]] });
    await expect(deps.service.evaluateAfterAdd(deps.client, "status-message", now))
      .resolves.toMatchObject({ state: "incomplete", participatingClanCount: 2, claimedClanCount: 0 });
    expect(deps.send).not.toHaveBeenCalled();
  });

  it("releases the reservation when a claim is removed during delivery preparation", async () => {
    const deps = makeDependencies();
    deps.rows[0].claims = [
      { clanTag: "#AAA111", userId: "user-a" },
      { clanTag: "#BBB222", userId: "user-b" },
    ];
    let channelFetchCount = 0;
    deps.guild.channels.fetch.mockImplementation(async () => {
      channelFetchCount += 1;
      if (channelFetchCount === 2) {
        deps.rows[0].claims = [{ clanTag: "#AAA111", userId: "user-a" }];
      }
      return deps.channel;
    });

    await expect(deps.service.evaluateAfterAdd(deps.client, "root-message", now))
      .resolves.toMatchObject({ state: "failed", reason: "root_or_completion_changed_before_send" });
    expect(deps.send).not.toHaveBeenCalled();
    expect(deps.events).toHaveLength(0);
  });

  it("releases the reservation when the root expires before final revalidation", async () => {
    const deps = makeDependencies({
      clock: () => new Date("2026-08-15T12:31:00.000Z"),
    });
    deps.rows[0].expiresAt = new Date("2026-08-15T12:30:00.000Z");
    deps.rows[1].expiresAt = new Date("2026-08-15T12:30:00.000Z");
    deps.rows[0].claims = [
      { clanTag: "#AAA111", userId: "user-a" },
      { clanTag: "#BBB222", userId: "user-b" },
    ];

    await expect(deps.service.evaluateAfterAdd(deps.client, "root-message", now))
      .resolves.toMatchObject({
        state: "failed",
        reason: "root_or_completion_changed_before_send",
      });
    expect(deps.send).not.toHaveBeenCalled();
    expect(deps.events).toHaveLength(0);
  });

  it("suppresses duplicate completion attempts through the durable event", async () => {
    const deps = makeDependencies();
    deps.rows[0].claims = [
      { clanTag: "#AAA111", userId: "user-a" },
      { clanTag: "#BBB222", userId: "user-b" },
    ];
    const results = await Promise.all([
      deps.service.evaluateAfterAdd(deps.client, "root-message", now),
      deps.service.evaluateAfterAdd(deps.client, "status-message", now),
    ]);
    expect(results.filter((result) => result.state === "delivered")).toHaveLength(1);
    expect(deps.send).toHaveBeenCalledTimes(1);
  });

  it("releases failed sends so recovery can retry without another reaction", async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(new Error("discord unavailable"))
      .mockResolvedValueOnce({ id: "announcement-2" });
    const deps = makeDependencies({ send });
    deps.rows[0].claims = [
      { clanTag: "#AAA111", userId: "user-a" },
      { clanTag: "#BBB222", userId: "user-b" },
    ];
    await expect(deps.service.evaluateAfterAdd(deps.client, "root-message", now))
      .resolves.toMatchObject({ state: "failed", reason: "discord_send_failed" });
    expect(deps.events.size).toBe(0);
    await expect(deps.service.reconcileDue(deps.client, now))
      .resolves.toMatchObject({ delivered: 1, failed: 0 });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("skips terminal roots before repeated recovery redoes routing or claim aggregation", async () => {
    const deps = makeDependencies();
    deps.rows[0].claims = [
      { clanTag: "#AAA111", userId: "user-a" },
      { clanTag: "#BBB222", userId: "user-b" },
    ];
    const info = vi.spyOn(dozzleLog, "info");

    await expect(deps.service.reconcileDue(deps.client, now))
      .resolves.toMatchObject({ delivered: 1, terminal: 0 });
    await expect(deps.service.reconcileDue(deps.client, now))
      .resolves.toMatchObject({ delivered: 0, terminal: 1, suppressed: 0, failed: 0 });

    expect(deps.send).toHaveBeenCalledTimes(1);
    expect(deps.routing.getChannelIdForType).toHaveBeenCalledTimes(2);
    expect(deps.trackedMessage.findMany.mock.calls.filter((call: any[]) => call[0]?.select?.claims))
      .toHaveLength(3);
    expect(info.mock.calls.filter(([message]) => String(message).includes("event=recovery_summary")))
      .toHaveLength(1);
    info.mockRestore();
  });

  it("preserves terminal delivery state across a new service instance", async () => {
    const deps = makeDependencies();
    deps.rows[0].claims = [
      { clanTag: "#AAA111", userId: "user-a" },
      { clanTag: "#BBB222", userId: "user-b" },
    ];
    await deps.service.evaluateAfterAdd(deps.client, "root-message", now);
    const restarted = new SyncAllSpunAnnouncementService(
      deps.routing as any,
      { trackedMessage: deps.trackedMessage, syncEvent: deps.syncEvent } as any,
      { POLLING_MODE: "active", DEPLOY_ENV: "prod" },
      () => new Date(now),
    );
    await expect(restarted.evaluateAfterAdd(deps.client, "root-message", now))
      .resolves.toMatchObject({ state: "suppressed" });
    expect(deps.send).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the configured sync destination is unavailable", async () => {
    const deps = makeDependencies();
    deps.rows[0].claims = [
      { clanTag: "#AAA111", userId: "user-a" },
      { clanTag: "#BBB222", userId: "user-b" },
    ];
    deps.routing.getChannelIdForType.mockResolvedValue(null);
    await expect(deps.service.evaluateAfterAdd(deps.client, "root-message", now))
      .resolves.toMatchObject({ state: "failed", reason: "sync_destination_unavailable" });
    expect(deps.send).not.toHaveBeenCalled();
    expect(deps.events.size).toBe(0);
  });

  it("excludes unrelated and expired child claims from the current root", async () => {
    const deps = makeDependencies();
    deps.rows[0].claims = [{ clanTag: "#AAA111", userId: "user-a" }];
    deps.rows.push(
      {
        ...deps.rows[1],
        id: "unrelated-status-id",
        messageId: "unrelated-status-message",
        guildId: "guild-2",
        referenceId: "other-root-message",
        claims: [{ clanTag: "#BBB222", userId: "user-b" }],
      },
      {
        ...deps.rows[1],
        id: "expired-status-id",
        messageId: "expired-status-message",
        expiresAt: new Date("2026-08-15T11:59:59.000Z"),
        claims: [{ clanTag: "#BBB222", userId: "user-c" }],
      },
    );

    await expect(deps.service.evaluateAfterAdd(deps.client, "root-message", now))
      .resolves.toMatchObject({
        state: "incomplete",
        participatingClanCount: 2,
        claimedClanCount: 1,
      });
    expect(deps.send).not.toHaveBeenCalled();
  });

  it("fails closed for early, replaced, expired, and malformed identities", async () => {
    const early = makeDependencies({ rows: makeRows(metadata({
      syncTimeIso: "2026-08-15T13:00:00.000Z",
      syncEpochSeconds: Math.floor(new Date("2026-08-15T13:00:00.000Z").getTime() / 1000),
    })) });
    early.rows[0].claims = [
      { clanTag: "#AAA111", userId: "user-a" },
      { clanTag: "#BBB222", userId: "user-b" },
    ];
    await expect(early.service.evaluateAfterAdd(early.client, "root-message", now))
      .resolves.toMatchObject({ state: "skipped", reason: "unresolved_current_root" });
    expect(early.send).not.toHaveBeenCalled();

    const replaced = makeDependencies();
    replaced.rows[0].status = "REPLACED";
    replaced.rows[0].claims = [
      { clanTag: "#AAA111", userId: "user-a" },
      { clanTag: "#BBB222", userId: "user-b" },
    ];
    await expect(replaced.service.evaluateAfterAdd(replaced.client, "status-message", now))
      .resolves.toMatchObject({ state: "skipped" });

    const expired = makeDependencies();
    expired.rows[0].expiresAt = new Date("2026-08-15T11:59:59.000Z");
    await expect(expired.service.evaluateAfterAdd(expired.client, "root-message", now))
      .resolves.toMatchObject({ state: "skipped" });

    const malformed = makeDependencies({ rows: makeRows(metadata({ syncTimeIso: "not-a-time" })) });
    await expect(malformed.service.evaluateAfterAdd(malformed.client, "root-message", now))
      .resolves.toMatchObject({ state: "skipped" });
  });

  it("keeps pre-sync claims for M1 delivery after the sync boundary", async () => {
    const futureSyncTime = new Date("2026-08-15T13:00:00.000Z");
    const deps = makeDependencies({
      rows: makeRows(metadata({
        syncTimeIso: futureSyncTime.toISOString(),
        syncEpochSeconds: Math.floor(futureSyncTime.getTime() / 1000),
      })),
    });
    for (const row of deps.rows) row.expiresAt = new Date("2026-08-15T15:00:00.000Z");
    deps.rows[0].claims = [
      { clanTag: "#AAA111", userId: "user-a" },
      { clanTag: "#BBB222", userId: "user-b" },
    ];

    await expect(deps.service.evaluateAfterAdd(
      deps.client,
      "root-message",
      new Date("2026-08-15T12:30:00.000Z"),
    )).resolves.toMatchObject({ state: "skipped", reason: "unresolved_current_root" });
    expect(deps.send).not.toHaveBeenCalled();

    await expect(deps.service.evaluateAfterAdd(
      deps.client,
      "root-message",
      new Date("2026-08-15T14:00:00.000Z"),
    )).resolves.toMatchObject({ state: "delivered" });
    expect(deps.send).toHaveBeenCalledTimes(1);
  });

  it("does not send from mirror or staging runtimes", async () => {
    const mirror = makeDependencies({ env: { POLLING_MODE: "mirror", DEPLOY_ENV: "prod" } });
    mirror.rows[0].claims = [
      { clanTag: "#AAA111", userId: "user-a" },
      { clanTag: "#BBB222", userId: "user-b" },
    ];
    await expect(mirror.service.evaluateAfterAdd(mirror.client, "root-message", now))
      .resolves.toEqual({ state: "skipped", reason: "non_production_runtime" });

    const staging = makeDependencies({ env: { POLLING_MODE: "active", DEPLOY_ENV: "staging" } });
    await expect(staging.service.reconcileDue(staging.client, now))
      .resolves.toMatchObject({ scanned: 0, delivered: 0 });
    expect(staging.send).not.toHaveBeenCalled();
  });
});
