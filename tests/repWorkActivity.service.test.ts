import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  repWorkActivityEvent: {
    create: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import { repWorkActivityService } from "../src/services/RepWorkActivityService";

describe("RepWorkActivityService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.repWorkActivityEvent.create.mockResolvedValue({});
  });

  it("records BASES_CHECKED with sync identity and prep timing", async () => {
    await expect(
      repWorkActivityService.recordBasesChecked({
        guildId: "guild-1",
        discordUserId: "111111111111111111",
        clanTag: "#pypy",
        syncMessageId: "sync-message-1",
        sourceMessageId: "base-swap-message-1",
        sourceTrackedMessageId: "tracked-1",
        warStartTime: new Date("2026-06-13T18:00:00.000Z"),
        opponentTag: "opp1",
        eventAt: new Date("2026-06-13T16:30:00.000Z"),
        metadata: {
          sourceVariant: "split",
        },
      }),
    ).resolves.toBe(true);

    expect(prismaMock.repWorkActivityEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          activityType: "BASES_CHECKED",
          guildId: "guild-1",
          discordUserId: "111111111111111111",
          clanTag: "#PYPY",
          syncMessageId: "sync-message-1",
          sourceMessageId: "base-swap-message-1",
          sourceTrackedMessageId: "tracked-1",
          warId: null,
          warStartTime: new Date("2026-06-13T18:00:00.000Z"),
          opponentTag: "#OPP1",
          eventAt: new Date("2026-06-13T16:30:00.000Z"),
          prepTimeLeftSeconds: 5400,
          dedupeKey:
            "rep-work|BASES_CHECKED|guild=guild-1|user=111111111111111111|clan=#PYPY|sync:sync-message-1",
        }),
      }),
    );
    expect(
      (prismaMock.repWorkActivityEvent.create.mock.calls[0]?.[0] as any)?.data?.metadata,
    ).toMatchObject({
      source: "base_swap",
    });
  });

  it("falls back to the source message id when sync identity is missing", async () => {
    prismaMock.repWorkActivityEvent.create.mockRejectedValueOnce({ code: "P2002" });

    await expect(
      repWorkActivityService.recordMailChecked({
        guildId: "guild-1",
        discordUserId: "222222222222222222",
        clanTag: "rr",
        sourceMessageId: "mail-message-1",
        sourceTrackedMessageId: "tracked-2",
        eventAt: new Date("2026-06-13T17:00:00.000Z"),
        metadata: {
          sourceVariant: "manual",
        },
      }),
    ).resolves.toBe(true);

    expect(prismaMock.repWorkActivityEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          activityType: "MAIL_CHECKED",
          clanTag: "#RR",
          syncMessageId: null,
          sourceMessageId: "mail-message-1",
          dedupeKey:
            "rep-work|MAIL_CHECKED|guild=guild-1|user=222222222222222222|clan=#RR|source:mail-message-1",
        }),
      }),
    );
  });

  it("records MAIL_CHECKED prep timing when the war start is known", async () => {
    await expect(
      repWorkActivityService.recordMailChecked({
        guildId: "guild-1",
        discordUserId: "333333333333333333",
        clanTag: "#RR",
        syncMessageId: "sync-message-2",
        sourceMessageId: "checklist-message-1",
        sourceTrackedMessageId: "tracked-3",
        warStartTime: new Date("2026-06-13T18:00:00.000Z"),
        eventAt: new Date("2026-06-13T17:40:00.000Z"),
        metadata: {
          checklistView: "Mail",
        },
      }),
    ).resolves.toBe(true);

    expect(prismaMock.repWorkActivityEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          activityType: "MAIL_CHECKED",
          guildId: "guild-1",
          discordUserId: "333333333333333333",
          clanTag: "#RR",
          syncMessageId: "sync-message-2",
          sourceMessageId: "checklist-message-1",
          sourceTrackedMessageId: "tracked-3",
          warStartTime: new Date("2026-06-13T18:00:00.000Z"),
          eventAt: new Date("2026-06-13T17:40:00.000Z"),
          prepTimeLeftSeconds: 1200,
          dedupeKey:
            "rep-work|MAIL_CHECKED|guild=guild-1|user=333333333333333333|clan=#RR|sync:sync-message-2",
        }),
      }),
    );
  });

  it("records MAIL_SENT for successful /fwa match mail sends", async () => {
    await expect(
      repWorkActivityService.recordMailSent({
        guildId: "guild-1",
        discordUserId: "444444444444444444",
        clanTag: "#RR",
        sourceMessageId: "mail-message-9",
        sourceTrackedMessageId: "source-match-message-1",
        warId: 1002001,
        warStartTime: new Date("2026-06-13T18:00:00.000Z"),
        opponentTag: "opp9",
        eventAt: new Date("2026-06-13T17:40:00.000Z"),
        metadata: {
          sourceVariant: "fwa_match",
        },
      }),
    ).resolves.toBe(true);

    expect(prismaMock.repWorkActivityEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          activityType: "MAIL_SENT",
          guildId: "guild-1",
          discordUserId: "444444444444444444",
          clanTag: "#RR",
          syncMessageId: null,
          sourceMessageId: "mail-message-9",
          sourceTrackedMessageId: "source-match-message-1",
          warId: "1002001",
          warStartTime: new Date("2026-06-13T18:00:00.000Z"),
          opponentTag: "#OPP9",
          eventAt: new Date("2026-06-13T17:40:00.000Z"),
          prepTimeLeftSeconds: 1200,
          dedupeKey:
            "rep-work|MAIL_SENT|guild=guild-1|user=444444444444444444|clan=#RR|source:mail-message-9",
        }),
      }),
    );
  });

  it("records checklist-attributed BASES_CHECKED events with checklist source metadata", async () => {
    await expect(
      repWorkActivityService.recordBasesChecklistChecked({
        guildId: "guild-1",
        discordUserId: "111111111111111111",
        clanTag: "#pypy",
        syncMessageId: "sync-message-1",
        sourceMessageId: "bases-message-1",
        sourceTrackedMessageId: "tracked-1",
        warStartTime: new Date("2026-06-13T18:00:00.000Z"),
        opponentTag: "opp1",
        eventAt: new Date("2026-06-13T16:30:00.000Z"),
        metadata: {
          sourceVariant: "checklist",
        },
      }),
    ).resolves.toBe(true);

    const createCall = prismaMock.repWorkActivityEvent.create.mock.calls[0]?.[0] as any;
    expect(createCall).toBeTruthy();
    expect(createCall.data.metadata).toMatchObject({
      source: "bases_checklist",
      activityType: "BASES_CHECKED",
    });
    expect(String(createCall.data.metadata.source)).not.toContain("base_swap");
  });
});
