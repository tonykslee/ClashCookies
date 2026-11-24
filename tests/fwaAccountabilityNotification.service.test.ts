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
} = {}) {
  const rows = new Map<string, any>();
  const sent: any[] = [];
  const channel = {
    guildId: "1000",
    isTextBased: () => true,
    send: options.send ?? (async (payload: any) => {
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
        const row = [...rows.values()].find((candidate) => candidate.id === where?.id);
        if (row) {
          Object.assign(row, {
            ...row,
            ...data,
            ...(data.attemptCount?.increment
              ? { attemptCount: (row.attemptCount ?? 0) + data.attemptCount.increment }
              : {}),
          });
        }
        return { count: 1 };
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
      opponentTag: "#OPP1",
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

  it("requires a safe authoritative war or sync identity", () => {
    expect(buildFwaAccountabilityWarSyncIdentityForTest({})).toBeNull();
    expect(buildFwaAccountabilityWarSyncIdentityForTest({ syncMessageId: "123456789012345683" })).toContain("sync=123456789012345683");
  });
});
