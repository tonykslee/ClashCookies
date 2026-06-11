import { beforeEach, describe, expect, it, vi } from "vitest";
import * as WeightInputDefermentService from "../src/services/WeightInputDefermentService";

const prismaMock = vi.hoisted(() => ({
  fwaClanMemberCurrent: {
    findMany: vi.fn(),
  },
  fwaPlayerCatalog: {
    findMany: vi.fn(),
  },
  playerCurrent: {
    findMany: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import { resolveLinkListDisplayWeightsByPlayerTags } from "../src/services/LinkListWeightService";

describe("resolveLinkListDisplayWeightsByPlayerTags", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([]);
    prismaMock.fwaPlayerCatalog.findMany.mockResolvedValue([]);
    prismaMock.playerCurrent.findMany.mockResolvedValue([]);
  });

  it("resolves member, catalog, and player-current weights in priority order", async () => {
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        weight: 0,
        sourceSyncedAt: new Date("2026-04-01T00:00:00.000Z"),
      },
      {
        playerTag: "#PYLQ0289",
        weight: 120000,
        sourceSyncedAt: new Date("2026-03-31T00:00:00.000Z"),
      },
      {
        playerTag: "#LCUV0289",
        weight: 98000,
        sourceSyncedAt: new Date("2026-04-01T00:00:00.000Z"),
      },
      {
        playerTag: "#QGRJ2222",
        weight: 0,
        sourceSyncedAt: new Date("2026-04-01T00:00:00.000Z"),
      },
    ]);
    prismaMock.fwaPlayerCatalog.findMany.mockResolvedValue([
      {
        playerTag: "#PYLQ0289",
        latestKnownWeight: 145000,
      },
      {
        playerTag: "#QGRJ2222",
        latestKnownWeight: 0,
      },
    ]);
    prismaMock.playerCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#QGRJ2222",
        currentWeight: 166000,
      },
      {
        playerTag: "#UNKNOWN",
        currentWeight: 155000,
      },
    ]);

    const resolved = await resolveLinkListDisplayWeightsByPlayerTags({
      playerTagsInOrder: ["pylq0289", "#qgrj2222", "#lcuv0289", "#GGRJ2222"],
    });

    expect(resolved.get("#PYLQ0289")).toBe(145000);
    expect(resolved.get("#QGRJ2222")).toBe(166000);
    expect(resolved.get("#LCUV0289")).toBe(98000);
    expect(resolved.get("#GGRJ2222")).toBeNull();
    expect(prismaMock.fwaClanMemberCurrent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
            playerTag: { in: ["#PYLQ0289", "#QGRJ2222", "#LCUV0289", "#GGRJ2222"] },
          }),
      }),
    );
  });

  it("prefers the higher of FWA and deferred weights and keeps FWA on ties", async () => {
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PQL0289",
        weight: 145000,
        sourceSyncedAt: new Date("2026-04-01T00:00:00.000Z"),
      },
      {
        playerTag: "#QGRJ2222",
        weight: 150000,
        sourceSyncedAt: new Date("2026-04-01T00:00:00.000Z"),
      },
      {
        playerTag: "#LCUV0289",
        weight: 150000,
        sourceSyncedAt: new Date("2026-04-01T00:00:00.000Z"),
      },
    ]);
    const deferredSpy = vi
      .spyOn(
        WeightInputDefermentService,
        "listOpenDeferredWeightsByClanAndPlayerTags",
      )
      .mockResolvedValue(
        new Map([
          [
            "#PQL0289",
            new Map([["#PQL0289", 150000], ["#QGRJ2222", 145000], ["#LCUV0289", 150000]]),
          ],
        ]),
      );

    const resolved = await resolveLinkListDisplayWeightsByPlayerTags({
      playerTagsInOrder: ["#PQL0289", "#QGRJ2222", "#LCUV0289"],
      guildId: "guild-1",
      clanTag: "#PQL0289",
    });

    expect(resolved.get("#PQL0289")).toBe(150000);
    expect(resolved.get("#QGRJ2222")).toBe(150000);
    expect(resolved.get("#LCUV0289")).toBe(150000);
    expect(deferredSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "guild-1",
        clanPlayerTags: [
          {
            clanTag: "#PQL0289",
            playerTags: ["#PQL0289", "#QGRJ2222", "#LCUV0289"],
          },
        ],
      }),
    );
  });

  it("skips deferred lookup when guildId or clanTag is missing", async () => {
    prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([
      {
        playerTag: "#PQL0289",
        weight: 145000,
        sourceSyncedAt: new Date("2026-04-01T00:00:00.000Z"),
      },
    ]);
    const deferredSpy = vi
      .spyOn(
        WeightInputDefermentService,
        "listOpenDeferredWeightsByClanAndPlayerTags",
      )
      .mockResolvedValue(new Map());

    const withoutGuild = await resolveLinkListDisplayWeightsByPlayerTags({
      playerTagsInOrder: ["#PQL0289"],
      guildId: null,
      clanTag: "#PQL0289",
    });
    const withoutClan = await resolveLinkListDisplayWeightsByPlayerTags({
      playerTagsInOrder: ["#PQL0289"],
      guildId: "guild-1",
      clanTag: null,
    });

    expect(withoutGuild.get("#PQL0289")).toBe(145000);
    expect(withoutClan.get("#PQL0289")).toBe(145000);
    expect(deferredSpy).not.toHaveBeenCalled();
  });
});
