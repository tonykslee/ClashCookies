import { describe, expect, it, vi } from "vitest";
import { FwaAccountabilityNotificationStatus } from "@prisma/client";
import {
  FwaAccountabilityNotificationService,
  buildFwaAccountabilityWarSyncIdentityForTest,
} from "../src/services/FwaAccountabilityNotificationService";

function createHarness(options: {
  routingMode?: string;
  channelId?: string | null;
  send?: (payload: any) => Promise<any>;
  seedRows?: any[];
  finalizeError?: boolean;
  beforeUpdateMany?: (args: any) => Promise<void>;
  afterUpdateMany?: (args: any, result: { count: number }) => void;
} = {}) {
  const rows = new Map<string, any>();
  for (const seed of options.seedRows ?? []) {
    rows.set(`${seed.eventType}:${seed.eventKey}`, seed);
  }
  const sent: any[] = [];
  const channel = {
    guildId: "1000",
    isTextBased: () => true,
    send: options.send ?? vi.fn(async (payload: any) => {
      sent.push(payload);
      return { id: String(900 + sent.length) };
    }),
  };
  const db = {
    trackedClan: {
      findFirst: vi.fn().mockResolvedValue({
        name: "Alpha Clan",
        shortName: "Alpha",
        logChannelId: "1002",
        leaderChannelId: "1001",
      }),
    },
    fwaAccountabilityNotification: {
      upsert: vi.fn(async ({ create }: any) => {
        const key = `${create.eventType}:${create.eventKey}`;
        const existing = rows.get(key);
        if (existing) return existing;
        const created = { id: `notification-${rows.size + 1}`, ...create };
        rows.set(key, created);
        return created;
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        await options.beforeUpdateMany?.({ where, data });
        if (options.finalizeError && data.status === FwaAccountabilityNotificationStatus.SENT) {
          throw new Error("database finalization unavailable");
        }
        const row = [...rows.values()].find((candidate) => candidate.id === where?.id);
        const matches = (candidate: any, clause: any): boolean => {
          if (clause === undefined) return true;
          if (clause && typeof clause === "object" && "in" in clause) {
            return clause.in.includes(candidate);
          }
          if (clause && typeof clause === "object" && "lt" in clause) {
            return candidate instanceof Date && candidate < clause.lt;
          }
          return candidate === clause;
        };
        const matchesWhere = row &&
          matches(row.status, where?.status) &&
          matches(row.claimToken, where?.claimToken) &&
          matches(row.claimedAt, where?.claimedAt);
        if (matchesWhere) {
          Object.assign(row, {
            ...row,
            ...data,
            ...(data.attemptCount?.increment
              ? { attemptCount: (row.attemptCount ?? 0) + data.attemptCount.increment }
              : {}),
          });
        }
        const result = { count: matchesWhere ? 1 : 0 };
        options.afterUpdateMany?.({ where, data }, result);
        return result;
      }),
    },
  };
  const botLogChannels = {
    getRoutingConfigForType: vi.fn().mockResolvedValue({
      routingMode: options.routingMode ?? "CLAN_LEAD",
      channelId: options.channelId ?? null,
      legacy: false,
      configured: true,
    }),
    getChannelId: vi.fn().mockResolvedValue("1003"),
  };
  const client = {
    channels: { fetch: vi.fn().mockResolvedValue(channel) },
    guilds: { cache: new Map() },
    user: { id: "1000" },
  };
  return {
    service: new FwaAccountabilityNotificationService(botLogChannels as any, db as any),
    client: client as any,
    db,
    botLogChannels,
    channel,
    sent,
    getRow: () => [...rows.values()][0],
    rows,
  };
}

describe("FWA accountability notifications", () => {
  it("uses clan-lead by default and deduplicates repeated bases acknowledgments", async () => {
    const harness = createHarness({
      routingMode: "CLAN_LEAD",
    });
    const input = {
      client: harness.client,
      guildId: "1000",
      clanTag: "#PYPY",
      actorUserId: "123456789012345678",
      warId: 1001,
      warStartTime: new Date("2026-11-24T10:00:00.000Z"),
      opponentTag: "#0PPY",
    };

    await expect(harness.service.notifyBasesChecked(input)).resolves.toBe(true);
    await expect(harness.service.notifyBasesChecked(input)).resolves.toBe(false);

    expect(harness.client.channels.fetch).toHaveBeenCalledWith("1001");
    expect(harness.sent).toHaveLength(1);
    expect(harness.sent[0].content).toContain("✅ Bases checked and all good by <@123456789012345678>");
    expect(harness.sent[0].content).toContain("Alpha (#PYPY)");
    expect(harness.sent[0].allowedMentions).toEqual({
      parse: [],
      users: ["123456789012345678"],
    });
    expect(harness.getRow().status).toBe(FwaAccountabilityNotificationStatus.SENT);
  });

  it("includes clan identity and keeps war identity stable across sync enrichment", async () => {
    const harness = createHarness();
    const base = {
      client: harness.client,
      guildId: "1000",
      actorUserId: "123456789012345678",
      warId: 1001,
      warStartTime: new Date("2026-11-24T10:00:00.000Z"),
      opponentTag: "#0PPY",
    };
    await expect(harness.service.notifyBasesChecked({ ...base, clanTag: "#PYPY", syncMessageId: "sync-a" })).resolves.toBe(true);
    await expect(harness.service.notifyBasesChecked({ ...base, clanTag: "#PYPL", syncMessageId: "sync-b" })).resolves.toBe(true);
    await expect(harness.service.notifyBasesChecked({ ...base, clanTag: "#PYPY", syncMessageId: "sync-c" })).resolves.toBe(false);
    expect(harness.sent).toHaveLength(2);
    expect([...harness.rows.values()].map((row) => row.eventKey)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('"clanTag":"#PYPL"'),
        expect.stringContaining('"clanTag":"#PYPY"'),
      ]),
    );
  });

  it.each([
    ["CLAN_LOG", "1002"],
    ["BOT_LOG", "1003"],
    ["CUSTOM", "1004"],
  ])("resolves %s routing without falling back", async (routingMode, expectedChannel) => {
    const harness = createHarness({ routingMode, channelId: routingMode === "CUSTOM" ? expectedChannel : null });
    await expect(harness.service.notifyBasesChecked({
      client: harness.client,
      guildId: "1000",
      clanTag: "#PYPY",
      actorUserId: "123456789012345678",
      syncMessageId: "123456789012345683",
    })).resolves.toBe(true);
    expect(harness.client.channels.fetch).toHaveBeenCalledWith(expectedChannel);
  });

  it("keeps initial mail publication and legitimate resend identities independent", async () => {
    const harness = createHarness();
    const base = {
      client: harness.client,
      guildId: "1000",
      clanTag: "#PYPY",
      actorUserId: "123456789012345678",
      warId: 1001,
      mailChannelId: "123456789012345679",
    };
    await expect(harness.service.notifyMailPosted({
      ...base,
      publicationIdentity: "send-key-1",
      resent: false,
      mailMessageId: "123456789012345680",
    })).resolves.toBe(true);
    await expect(harness.service.notifyMailPosted({
      ...base,
      publicationIdentity: "send-key-2",
      resent: true,
      mailMessageId: "123456789012345681",
    })).resolves.toBe(true);

    expect(harness.sent).toHaveLength(2);
    expect(harness.sent[0].content).toContain("📨 Clan mail posted");
    expect(harness.sent[1].content).toContain("📨 Clan mail resent");
    expect(harness.sent[0].content).toContain("https://discord.com/channels/1000/123456789012345679/123456789012345680");
    await expect(harness.service.notifyMailPosted({
      ...base,
      publicationIdentity: "different-send-key",
      resent: true,
      mailMessageId: "123456789012345680",
    })).resolves.toBe(false);
  });

  it("keeps manual checklist confirmation distinct from mail publication", async () => {
    const harness = createHarness();
    await expect(harness.service.notifyMailConfirmed({
      client: harness.client,
      guildId: "1000",
      clanTag: "#PYPY",
      actorUserId: "123456789012345678",
      syncMessageId: "123456789012345683",
      checklistChannelId: "123456789012345679",
      checklistMessageId: "123456789012345682",
    })).resolves.toBe(true);
    expect(harness.sent[0].content).toContain("✅ Clan mail marked as sent by <@123456789012345678>");
    expect(harness.sent[0].content).toContain("[View Checklist](https://discord.com/channels/1000/123456789012345679/123456789012345682)");
    expect(harness.sent[0].content).not.toContain("Clan mail posted");
  });

  it("does not deliver disabled routes and preserves source-action failure isolation", async () => {
    const disabled = createHarness({ routingMode: "DISABLED" });
    await expect(disabled.service.notifyBasesChecked({
      client: disabled.client,
      guildId: "1000",
      clanTag: "#PYPY",
      actorUserId: "123456789012345678",
      syncMessageId: "123456789012345683",
    })).resolves.toBe(false);
    expect(disabled.sent).toHaveLength(0);

    const failed = createHarness({
      send: vi.fn().mockRejectedValue(Object.assign(new Error("missing permission"), { code: 50013 })),
    });
    await expect(failed.service.notifyBasesChecked({
      client: failed.client,
      guildId: "1000",
      clanTag: "#PYPY",
      actorUserId: "123456789012345678",
      syncMessageId: "123456789012345683",
    })).resolves.toBe(false);
    expect(failed.getRow().status).toBe(FwaAccountabilityNotificationStatus.FAILED);
  });

  it("serializes concurrent claims and preserves the committed actor on retry", async () => {
    const harness = createHarness();
    const first = harness.service.notifyBasesChecked({
      client: harness.client,
      guildId: "1000",
      clanTag: "#PYPY",
      actorUserId: "123456789012345678",
      syncMessageId: "123456789012345683",
    });
    const second = harness.service.notifyBasesChecked({
      client: harness.client,
      guildId: "1000",
      clanTag: "#PYPY",
      actorUserId: "123456789012345679",
      syncMessageId: "123456789012345683",
    });
    await expect(Promise.all([first, second])).resolves.toEqual([true, false]);
    expect(harness.sent).toHaveLength(1);
    expect(harness.sent[0].content).toContain("<@123456789012345678>");

    const retrySend = vi.fn(async (payload: any) => {
      harness.sent.push(payload);
      return { id: "901" };
    });
    const retryHarness = createHarness({
      send: vi.fn()
        .mockRejectedValueOnce(Object.assign(new Error("permission denied"), { code: 50013 }))
        .mockImplementation(retrySend),
    });
    await expect(retryHarness.service.notifyBasesChecked({
      client: retryHarness.client,
      guildId: "1000",
      clanTag: "#PYPY",
      actorUserId: "123456789012345678",
      syncMessageId: "123456789012345683",
    })).resolves.toBe(false);
    await expect(retryHarness.service.notifyBasesChecked({
      client: retryHarness.client,
      guildId: "1000",
      clanTag: "#PYPY",
      actorUserId: "123456789012345679",
      syncMessageId: "123456789012345683",
    })).resolves.toBe(true);
    expect(retrySend).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining("<@123456789012345678>"),
    }));
  });

  it("atomically acquires one retry when callers both observe FAILED", async () => {
    const eventKey = JSON.stringify({
      version: 2,
      clanTag: "#PYPY",
      kind: "sync",
      syncMessageId: "123456789012345683",
    });
    let observations = 0;
    let releaseObservationBarrier!: () => void;
    const observationBarrier = new Promise<void>((resolve) => {
      releaseObservationBarrier = resolve;
    });
    const acquiredTokens: string[] = [];
    const finalizedTokens: string[] = [];
    const harness = createHarness({
      seedRows: [{
        id: "failed-retry-1",
        eventType: "BASES_CHECKED",
        eventKey: `bases:${eventKey}`,
        actorUserId: "123456789012345678",
        status: FwaAccountabilityNotificationStatus.FAILED,
        claimToken: "old-failed-token",
        claimedAt: null,
        attemptCount: 1,
      }],
      beforeUpdateMany: async ({ where, data }) => {
        const isRetryAcquisition =
          data?.status === FwaAccountabilityNotificationStatus.CLAIMED &&
          where?.status === FwaAccountabilityNotificationStatus.FAILED;
        if (!isRetryAcquisition) return;
        observations += 1;
        if (observations === 2) releaseObservationBarrier();
        await observationBarrier;
      },
      afterUpdateMany: ({ where, data }, result) => {
        const isRetryAcquisition =
          data?.status === FwaAccountabilityNotificationStatus.CLAIMED &&
          where?.status === FwaAccountabilityNotificationStatus.FAILED;
        if (isRetryAcquisition && result.count === 1) {
          acquiredTokens.push(data.claimToken);
        }
        if (data?.status === FwaAccountabilityNotificationStatus.SENT) {
          finalizedTokens.push(where.claimToken);
        }
      },
    });

    const first = harness.service.notifyBasesChecked({
      client: harness.client,
      guildId: "1000",
      clanTag: "#PYPY",
      actorUserId: "123456789012345679",
      syncMessageId: "123456789012345683",
    });
    const second = harness.service.notifyBasesChecked({
      client: harness.client,
      guildId: "1000",
      clanTag: "#PYPY",
      actorUserId: "123456789012345680",
      syncMessageId: "123456789012345683",
    });

    const results = await Promise.all([first, second]);
    expect(observations).toBe(2);
    expect(acquiredTokens).toHaveLength(1);
    expect(harness.getRow().actorUserId).toBe("123456789012345678");
    expect(harness.db.fwaAccountabilityNotification.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: FwaAccountabilityNotificationStatus.FAILED,
        }),
      }),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(harness.channel.send).toHaveBeenCalledTimes(1);
    expect(finalizedTokens).toEqual(acquiredTokens);
    expect(harness.sent).toHaveLength(1);
    expect(harness.getRow().status).toBe(FwaAccountabilityNotificationStatus.SENT);
  });

  it("fails closed after a successful Discord send when finalization is unavailable", async () => {
    const harness = createHarness({ finalizeError: true });
    await expect(harness.service.notifyBasesChecked({
      client: harness.client,
      guildId: "1000",
      clanTag: "#PYPY",
      actorUserId: "123456789012345678",
      syncMessageId: "123456789012345683",
    })).resolves.toBe(false);
    expect(harness.sent).toHaveLength(1);
    expect(harness.getRow().status).toBe(FwaAccountabilityNotificationStatus.CLAIMED);

    harness.getRow().claimedAt = new Date(Date.now() - 10 * 60 * 1000);
    await expect(harness.service.notifyBasesChecked({
      client: harness.client,
      guildId: "1000",
      clanTag: "#PYPY",
      actorUserId: "123456789012345679",
      syncMessageId: "123456789012345683",
    })).resolves.toBe(false);
    expect(harness.sent).toHaveLength(1);
    expect(harness.getRow().status).toBe(FwaAccountabilityNotificationStatus.UNKNOWN);
  });

  it("does not reclaim an expired claim and treats unknown send errors as terminal", async () => {
    const eventKey = JSON.stringify({
      version: 2,
      clanTag: "#PYPY",
      kind: "sync",
      syncMessageId: "123456789012345683",
    });
    const expired = createHarness({
      seedRows: [{
        id: "expired-1",
        eventType: "BASES_CHECKED",
        eventKey: `bases:${eventKey}`,
        actorUserId: "123456789012345678",
        status: FwaAccountabilityNotificationStatus.CLAIMED,
        claimToken: "old-claim",
        claimedAt: new Date(Date.now() - 10 * 60 * 1000),
        attemptCount: 1,
      }],
    });
    await expect(expired.service.notifyBasesChecked({
      client: expired.client,
      guildId: "1000",
      clanTag: "#PYPY",
      actorUserId: "123456789012345679",
      syncMessageId: "123456789012345683",
    })).resolves.toBe(false);
    expect(expired.sent).toHaveLength(0);
    expect(expired.getRow().status).toBe(FwaAccountabilityNotificationStatus.UNKNOWN);

    const unknown = createHarness({
      send: vi.fn().mockRejectedValue(new Error("connection reset after request")),
    });
    await expect(unknown.service.notifyBasesChecked({
      client: unknown.client,
      guildId: "1000",
      clanTag: "#PYPY",
      actorUserId: "123456789012345678",
      syncMessageId: "123456789012345683",
    })).resolves.toBe(false);
    expect(unknown.getRow().status).toBe(FwaAccountabilityNotificationStatus.UNKNOWN);
  });

  it("requires a safe authoritative war or sync identity", () => {
    expect(buildFwaAccountabilityWarSyncIdentityForTest({ clanTag: "#PYPY" })).toBeNull();
    expect(buildFwaAccountabilityWarSyncIdentityForTest({ clanTag: "#PYPY", syncMessageId: "123456789012345683" })).toContain('"kind":"sync"');
    expect(buildFwaAccountabilityWarSyncIdentityForTest({
      clanTag: "#PYPY",
      warId: 1001,
      syncMessageId: "123456789012345683",
    })).toBeNull();
    const completeWarIdentity = buildFwaAccountabilityWarSyncIdentityForTest({
      clanTag: "#PYPY",
      warId: 1001,
      warStartTime: new Date("2026-11-24T10:00:00.000Z"),
      opponentTag: "#0PPY",
      syncMessageId: "sync-enrichment",
    });
    expect(completeWarIdentity).toContain('"kind":"war"');
    expect(completeWarIdentity).toBe(buildFwaAccountabilityWarSyncIdentityForTest({
      clanTag: "#PYPY",
      warId: 1001,
      warStartTime: new Date("2026-11-24T10:00:00.000Z"),
      opponentTag: "#0PPY",
    }));
  });
});
