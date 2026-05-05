import { beforeEach, describe, expect, it, vi } from "vitest";

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
});
