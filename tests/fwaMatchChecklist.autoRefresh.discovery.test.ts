import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  trackedMessage: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    updateMany: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({ prisma: prismaMock }));

import { TRACKED_MESSAGE_STATUS, trackedMessageService } from "../src/services/TrackedMessageService";

const syncEpochSeconds = Math.floor(new Date("2026-05-13T00:00:00.000Z").getTime() / 1000);

function root(messageId: string, createdAt: string, status = TRACKED_MESSAGE_STATUS.ACTIVE) {
  return {
    guildId: "guild-1",
    messageId,
    createdAt: new Date(createdAt),
    metadata: {
      syncTimeIso: new Date(syncEpochSeconds * 1000).toISOString(),
      syncEpochSeconds,
      roleId: "role-1",
      clans: [{
        code: "RR",
        clanTag: "#PYPY",
        clanName: "Rocky Road",
        emojiId: "111",
        emojiName: "rr",
        emojiInline: "<:rr:111>",
      }],
    },
    status,
  };
}

function checklist(messageId: string, referenceId: string) {
  return {
    guildId: "guild-1",
    channelId: "checklist-channel",
    messageId,
    referenceId,
    expiresAt: new Date("2026-05-14T00:00:00.000Z"),
    status: TRACKED_MESSAGE_STATUS.ACTIVE,
    metadata: {
      kind: "mail_checklist",
      createdByUserId: "system",
      createdAtIso: "2026-05-13T00:01:00.000Z",
      rows: [{
        clanTag: "#PYPY",
        compactCopyLine: "RR | 🟢 | #OPP | FWA-WIN",
        badgeEmojiId: "111",
        badgeEmojiName: "rr",
        badgeEmojiInline: "<:rr:111>",
        matchType: "FWA",
        outcome: "WIN",
      }],
    },
  };
}

describe("FWA checklist refresh target discovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.trackedMessage.findUnique.mockResolvedValue(null);
    prismaMock.trackedMessage.updateMany.mockResolvedValue({ count: 0 });
  });

  it("retains an eligible checklist after its one-hour sync root expiry", async () => {
    const nowMs = new Date("2026-05-13T01:15:00.000Z").getTime();
    const checklistRow = checklist("mail-1", "sync-1");
    const expiredRoot = root("sync-1", "2026-05-13T00:00:00.000Z", TRACKED_MESSAGE_STATUS.EXPIRED);
    prismaMock.trackedMessage.findMany
      .mockResolvedValueOnce([checklistRow])
      .mockResolvedValueOnce([expiredRoot]);

    const targets = await trackedMessageService.findCurrentFwaMatchChecklistAutoRefreshTargets(nowMs);

    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      messageId: "mail-1",
      syncIdentity: "sync-1",
      syncEpochSeconds,
    });
    expect(prismaMock.trackedMessage.findMany).toHaveBeenCalledTimes(2);
  });

  it("rejects previous-sync checklists when a newer legitimate root exists", async () => {
    const nowMs = new Date("2026-05-13T01:15:00.000Z").getTime();
    prismaMock.trackedMessage.findMany
      .mockResolvedValueOnce([
        checklist("mail-old", "sync-old"),
        checklist("mail-new", "sync-new"),
      ])
      .mockResolvedValueOnce([
        root("sync-new", "2026-05-13T01:10:00.000Z"),
        root("sync-old", "2026-05-13T00:00:00.000Z", TRACKED_MESSAGE_STATUS.REPLACED),
      ]);

    const targets = await trackedMessageService.findCurrentFwaMatchChecklistAutoRefreshTargets(nowMs);

    expect(targets.map((target) => target.messageId)).toEqual(["mail-new"]);
  });

  it("claims a cadence slot once and does not replay it after restart", async () => {
    const nowMs = new Date("2026-05-13T00:15:00.000Z").getTime();
    const tracked: any = {
      id: "tracked-mail-1",
      status: TRACKED_MESSAGE_STATUS.ACTIVE,
      expiresAt: new Date("2026-05-14T00:00:00.000Z"),
      metadata: {
        kind: "mail_checklist",
        createdByUserId: "system",
        createdAtIso: "2026-05-13T00:00:00.000Z",
        rows: [checklist("mail-1", "sync-1").metadata.rows[0]],
      },
    };
    prismaMock.trackedMessage.findUnique.mockImplementation(async () => tracked);
    prismaMock.trackedMessage.updateMany.mockImplementation(async ({ data }: any) => {
      tracked.metadata = data.metadata;
      return { count: 1 };
    });

    const first = await trackedMessageService.claimFwaMatchChecklistAutoRefresh({
      messageId: "mail-1",
      nowMs,
      safetyCutoffAtMs: new Date("2026-05-13T06:00:00.000Z").getTime(),
      intervalMs: 15 * 60 * 1000,
    });
    const second = await trackedMessageService.claimFwaMatchChecklistAutoRefresh({
      messageId: "mail-1",
      nowMs,
      safetyCutoffAtMs: new Date("2026-05-13T06:00:00.000Z").getTime(),
      intervalMs: 15 * 60 * 1000,
    });

    expect(first.claimed).toBe(true);
    expect(second).toMatchObject({ claimed: false, reason: "not_due" });
    expect(prismaMock.trackedMessage.updateMany).toHaveBeenCalledTimes(1);
  });
});
