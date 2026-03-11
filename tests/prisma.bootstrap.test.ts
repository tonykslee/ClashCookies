import { afterEach, describe, expect, it, vi } from "vitest";

describe("prisma bootstrap", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock("@prisma/client");
  });

  it("does not instantiate Prisma on import or delegate spy setup", async () => {
    const ctor = vi.fn(() => ({
      warMailLifecycle: {
        findUnique: vi.fn(),
      },
    }));
    vi.doMock("@prisma/client", () => ({
      PrismaClient: ctor,
    }));

    const { prisma } = await import("../src/prisma");
    expect(ctor).not.toHaveBeenCalled();

    vi.spyOn(prisma.warMailLifecycle, "findUnique").mockResolvedValue(null as never);
    expect(ctor).not.toHaveBeenCalled();
  });

  it("constructs the real Prisma client on first real DB call", async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: 123 });
    const ctor = vi.fn(() => ({
      clanWarPlan: {
        findFirst,
      },
    }));
    vi.doMock("@prisma/client", () => ({
      PrismaClient: ctor,
    }));

    const { prisma } = await import("../src/prisma");
    const result = await prisma.clanWarPlan.findFirst({
      where: { clanTag: "#AAA111" },
    } as never);

    expect(ctor).toHaveBeenCalledTimes(1);
    expect(findFirst).toHaveBeenCalledWith({
      where: { clanTag: "#AAA111" },
    });
    expect(result).toEqual({ id: 123 });
  });

  it("wraps Prisma initialization failures with an actionable error", async () => {
    vi.doMock("@prisma/client", () => ({
      PrismaClient: vi.fn(() => {
        throw new Error("Missing DATABASE_URL");
      }),
    }));

    const { prisma } = await import("../src/prisma");

    await expect(
      (async () =>
        prisma.warMailLifecycle.findUnique({
          where: { guildId_clanTag_warId: { guildId: "g", clanTag: "#A", warId: 1 } },
        } as never))()
    ).rejects.toThrow(/Failed to initialize Prisma client/);

    await expect(
      (async () =>
        prisma.warMailLifecycle.findUnique({
          where: { guildId_clanTag_warId: { guildId: "g", clanTag: "#A", warId: 1 } },
        } as never))()
    ).rejects.toThrow(/DATABASE_URL/);
  });
});
