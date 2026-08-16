import { describe, expect, it, vi } from "vitest";
import {
  claimSyncEvent,
  markSyncEventSuppressed,
  SYNC_EVENT_RESERVATION_LEASE_MS,
} from "../src/services/SyncEventDeliveryService";

const identity = {
  guildId: "guild-1",
  syncTime: new Date("2026-08-15T11:00:00.000Z"),
  clanTag: "",
  eventType: "sync_retrospective:auto_post",
};

function makeModel(initial?: { payload: any; createdAt: Date }) {
  let row: any = initial
    ? { ...identity, payload: initial.payload, createdAt: initial.createdAt }
    : null;
  const sameIdentity = (where: any) => where.guildId === identity.guildId &&
    where.syncTime.getTime() === identity.syncTime.getTime() &&
    where.clanTag === identity.clanTag && where.eventType === identity.eventType;
  return {
    findFirst: vi.fn(async () => row),
    create: vi.fn(async ({ data }: any) => {
      if (row) throw Object.assign(new Error("unique"), { code: "P2002" });
      row = { ...data, createdAt: new Date("2026-08-16T12:00:00.000Z") };
      return { id: "event-1", createdAt: row.createdAt };
    }),
    updateMany: vi.fn(async ({ where, data }: any) => {
      if (!row || !sameIdentity(where) || row.createdAt.getTime() !== where.createdAt.getTime()) return { count: 0 };
      if (where.payload?.equals && JSON.stringify(where.payload.equals) !== JSON.stringify(row.payload)) return { count: 0 };
      row.payload = data.payload;
      return { count: 1 };
    }),
    getRow: () => row,
  };
}

describe("SyncEventDeliveryService", () => {
  it("preserves actionable claim database failure context", async () => {
    const model = {
      findFirst: vi.fn().mockRejectedValue(new Error("database connection refused")),
      create: vi.fn(),
    };
    const result = await claimSyncEvent({
      eventModel: model,
      identity,
      now: new Date("2026-08-16T12:00:00.000Z"),
      claimedPayload: { status: "claimed" },
    });
    expect(result).toEqual({
      state: "unavailable",
      reason: "reservation_unavailable:database connection refused",
    });
  });

  it("creates suppression when no event exists and treats terminal rows as handled", async () => {
    const model = makeModel();
    await expect(markSyncEventSuppressed({
      eventModel: model,
      identity,
      now: new Date("2026-08-16T12:00:00.000Z"),
      suppressedPayload: { status: "suppressed" },
    })).resolves.toEqual({ state: "suppressed", reason: "created" });

    for (const status of ["suppressed", "delivered"]) {
      const terminal = makeModel({
        payload: { status },
        createdAt: new Date("2026-08-15T00:00:00.000Z"),
      });
      await expect(markSyncEventSuppressed({
        eventModel: terminal,
        identity,
        now: new Date("2026-08-16T12:00:00.000Z"),
        suppressedPayload: { status: "suppressed" },
      })).resolves.toMatchObject({ state: "terminal" });
      expect(terminal.updateMany).not.toHaveBeenCalled();
    }
  });

  it("does not steal a fresh claim and reclaims an expired claim", async () => {
    const now = new Date("2026-08-16T12:00:00.000Z");
    const fresh = makeModel({ payload: { status: "claimed" }, createdAt: now });
    await expect(markSyncEventSuppressed({
      eventModel: fresh,
      identity,
      now,
      suppressedPayload: { status: "suppressed" },
    })).resolves.toMatchObject({ state: "in_flight" });
    expect(fresh.getRow().payload).toMatchObject({ status: "claimed" });

    const expired = makeModel({
      payload: { status: "claimed" },
      createdAt: new Date(now.getTime() - SYNC_EVENT_RESERVATION_LEASE_MS - 1),
    });
    await expect(markSyncEventSuppressed({
      eventModel: expired,
      identity,
      now,
      suppressedPayload: { status: "suppressed" },
    })).resolves.toEqual({ state: "suppressed", reason: "reclaimed" });
    expect(expired.getRow().payload).toMatchObject({ status: "suppressed" });
  });

  it("keeps concurrent suppression creation race-safe", async () => {
    const model = makeModel();
    const results = await Promise.all([
      markSyncEventSuppressed({ eventModel: model, identity, suppressedPayload: { status: "suppressed" } }),
      markSyncEventSuppressed({ eventModel: model, identity, suppressedPayload: { status: "suppressed" } }),
    ]);
    expect(results.filter((result) => result.state === "suppressed")).toHaveLength(1);
    expect(model.getRow().payload).toMatchObject({ status: "suppressed" });
  });
});
