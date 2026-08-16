import { Prisma } from "@prisma/client";
import { formatError } from "../helper/formatError";
import { normalizeTag } from "./war-events/core";

export const SYNC_EVENT_RESERVATION_LEASE_MS = 5 * 60 * 1000;

export type SyncEventDeliveryIdentity = {
  guildId: string;
  syncTime: Date;
  clanTag: string;
  eventType: string;
};

export type SyncEventClaimResult =
  | { state: "claimed"; createdAt: Date; reason: "claimed" | "reclaimed" }
  | { state: "in_flight"; reason: string }
  | { state: "unavailable"; reason: string };

export type SyncEventSuppressionResult =
  | { state: "suppressed"; reason: "created" | "reclaimed" }
  | { state: "terminal"; reason: "already_delivered" | "already_suppressed" }
  | { state: "in_flight"; reason: string }
  | { state: "unavailable"; reason: string };

export function syncEventKey(input: SyncEventDeliveryIdentity): string {
  return `${input.guildId}|${input.syncTime.toISOString()}|${normalizeTag(input.clanTag)}|${input.eventType}`;
}

export function syncEventPayloadStatus(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const status = (payload as { status?: unknown }).status;
  return typeof status === "string" ? status : null;
}

export function isSyncEventReservationExpired(createdAt: Date, now: Date): boolean {
  return now.getTime() - createdAt.getTime() >= SYNC_EVENT_RESERVATION_LEASE_MS;
}

function isUniqueConflict(error: unknown): boolean {
  return (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") ||
    String((error as { code?: unknown } | null | undefined)?.code ?? "") === "P2002";
}

/** Purpose: reserve one unique SyncEvent delivery with the shared claim/reclaim lease semantics. */
export async function claimSyncEvent(input: {
  eventModel: any;
  identity: SyncEventDeliveryIdentity;
  now: Date;
  claimedPayload: Record<string, unknown>;
}): Promise<SyncEventClaimResult> {
  const identity = {
    guildId: input.identity.guildId,
    syncTime: input.identity.syncTime,
    clanTag: normalizeTag(input.identity.clanTag),
    eventType: input.identity.eventType,
  };
  try {
    const existing = await input.eventModel.findFirst({
      where: identity,
      select: { createdAt: true, payload: true },
    });
    if (existing) {
      const status = syncEventPayloadStatus(existing.payload);
      if (status === "delivered" || status === "suppressed") {
        return { state: "in_flight", reason: `already_${status}` };
      }
      if (!isSyncEventReservationExpired(existing.createdAt, input.now)) {
        return { state: "in_flight", reason: "reservation_in_flight" };
      }
      const reclaimed = await input.eventModel.deleteMany({
        where: {
          ...identity,
          createdAt: existing.createdAt,
          payload: { path: ["status"], equals: "claimed" },
        },
      });
      if (reclaimed.count !== 1) {
        return { state: "in_flight", reason: "reservation_ownership_lost" };
      }
    }

    const created = await input.eventModel.create({
      data: { ...identity, payload: input.claimedPayload },
      select: { createdAt: true },
    });
    return {
      state: "claimed",
      createdAt: created.createdAt,
      reason: existing ? "reclaimed" : "claimed",
    };
  } catch (error) {
    if (isUniqueConflict(error)) {
      return { state: "in_flight", reason: "reservation_already_claimed" };
    }
    return {
      state: "unavailable",
      reason: `reservation_unavailable:${formatError(error)}`,
    };
  }
}

/** Purpose: transition an owned SyncEvent reservation to a terminal delivered payload. */
export async function markSyncEventDelivered(input: {
  eventModel: any;
  identity: SyncEventDeliveryIdentity;
  createdAt: Date;
  deliveredPayload: Record<string, unknown>;
}): Promise<boolean> {
  const result = await input.eventModel.updateMany({
    where: {
      guildId: input.identity.guildId,
      syncTime: input.identity.syncTime,
      clanTag: normalizeTag(input.identity.clanTag),
      eventType: input.identity.eventType,
      createdAt: input.createdAt,
      payload: { path: ["status"], equals: "claimed" },
    },
    data: { payload: input.deliveredPayload },
  }).catch(() => ({ count: 0 }));
  return result.count === 1;
}

/** Purpose: release only the current owner's reservation so failed deliveries remain retryable. */
export async function releaseSyncEvent(input: {
  eventModel: any;
  identity: SyncEventDeliveryIdentity;
  createdAt: Date;
}): Promise<void> {
  await input.eventModel.deleteMany({
    where: {
      guildId: input.identity.guildId,
      syncTime: input.identity.syncTime,
      clanTag: normalizeTag(input.identity.clanTag),
      eventType: input.identity.eventType,
      createdAt: input.createdAt,
      payload: { path: ["status"], equals: "claimed" },
    },
  }).catch(() => undefined);
}

function suppressionIdentity(input: SyncEventDeliveryIdentity) {
  return {
    guildId: input.guildId,
    syncTime: input.syncTime,
    clanTag: normalizeTag(input.clanTag),
    eventType: input.eventType,
  };
}

function classifySuppressionReservation(
  existing: { createdAt: Date; payload: unknown },
  now: Date,
): SyncEventSuppressionResult | null {
  const status = syncEventPayloadStatus(existing.payload);
  if (status === "delivered") return { state: "terminal", reason: "already_delivered" };
  if (status === "suppressed") return { state: "terminal", reason: "already_suppressed" };
  if (!isSyncEventReservationExpired(existing.createdAt, now)) {
    return { state: "in_flight", reason: "reservation_in_flight" };
  }
  return null;
}

/** Purpose: write or lease-reclaim a terminal suppression marker without stealing a live delivery owner. */
export async function markSyncEventSuppressed(input: {
  eventModel: any;
  identity: SyncEventDeliveryIdentity;
  now?: Date;
  suppressedPayload: Record<string, unknown>;
}): Promise<SyncEventSuppressionResult> {
  const identity = suppressionIdentity(input.identity);
  const now = input.now ?? new Date();
  try {
    const existing = await input.eventModel.findFirst({
      where: identity,
      select: { createdAt: true, payload: true },
    });
    if (existing) {
      const classified = classifySuppressionReservation(existing, now);
      if (classified) return classified;

      const reclaimed = await input.eventModel.updateMany({
        where: {
          ...identity,
          createdAt: existing.createdAt,
          payload: { equals: existing.payload },
        },
        data: { payload: input.suppressedPayload },
      });
      if (reclaimed.count === 1) {
        return { state: "suppressed", reason: "reclaimed" };
      }

      const current = await input.eventModel.findFirst({
        where: identity,
        select: { createdAt: true, payload: true },
      });
      if (!current) return { state: "in_flight", reason: "reservation_ownership_lost" };
      const currentState = classifySuppressionReservation(current, now);
      return currentState ?? { state: "in_flight", reason: "reservation_ownership_lost" };
    }

    await input.eventModel.create({
      data: { ...identity, payload: input.suppressedPayload },
      select: { id: true },
    });
    return { state: "suppressed", reason: "created" };
  } catch (error) {
    if (isUniqueConflict(error)) {
      const current = await input.eventModel.findFirst({
        where: identity,
        select: { createdAt: true, payload: true },
      }).catch(() => null);
      if (!current) return { state: "in_flight", reason: "reservation_race" };
      const currentState = classifySuppressionReservation(current, now);
      if (currentState) return currentState;
      return { state: "in_flight", reason: "reservation_race" };
    }
    return { state: "unavailable", reason: `suppression_unavailable:${formatError(error)}` };
  }
}
