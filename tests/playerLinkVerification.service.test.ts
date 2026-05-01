import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlayerLinkVerificationService } from "../src/services/PlayerLinkVerificationService";

const prismaMock = vi.hoisted(() => ({
  playerLink: {
    findUnique: vi.fn(),
    updateMany: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

describe("PlayerLinkVerificationService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.playerLink.findUnique.mockReset();
    prismaMock.playerLink.updateMany.mockReset();
  });

  it("verifies an owned link via player API token and marks it verified", async () => {
    prismaMock.playerLink.findUnique.mockResolvedValue({
      discordUserId: "111111111111111111",
    });
    prismaMock.playerLink.updateMany.mockResolvedValue({ count: 1 });
    const cocService = {
      verifyPlayerToken: vi.fn().mockResolvedValue({
        tag: "#PYL0289",
        status: "ok",
      }),
    };

    const service = new PlayerLinkVerificationService(cocService as any);
    const result = await service.verifyPlayerToken({
      playerTag: "#pyl0289",
      discordUserId: "111111111111111111",
      token: "TOKEN-123",
    });

    expect(cocService.verifyPlayerToken).toHaveBeenCalledWith(
      "#PYL0289",
      "TOKEN-123",
    );
    expect(prismaMock.playerLink.updateMany).toHaveBeenCalledWith({
      where: { playerTag: "#PYL0289" },
      data: {
        verificationStatus: "VERIFIED",
        verificationMethod: "PLAYER_API_TOKEN",
        verifiedAt: expect.any(Date),
        verifiedByDiscordUserId: "111111111111111111",
        lastVerifiedAt: expect.any(Date),
        verificationFailureReason: null,
      },
    });
    expect(result).toEqual({
      outcome: "verified",
      playerTag: "#PYL0289",
      discordUserId: "111111111111111111",
    });
  });

  it("records a safe failure reason when token verification fails", async () => {
    prismaMock.playerLink.findUnique.mockResolvedValue({
      discordUserId: "111111111111111111",
    });
    prismaMock.playerLink.updateMany.mockResolvedValue({ count: 1 });
    const cocService = {
      verifyPlayerToken: vi.fn().mockResolvedValue(null),
    };

    const service = new PlayerLinkVerificationService(cocService as any);
    const result = await service.verifyPlayerToken({
      playerTag: "#pyl0289",
      discordUserId: "111111111111111111",
      token: "TOKEN-123",
    });

    expect(prismaMock.playerLink.updateMany).toHaveBeenCalledWith({
      where: { playerTag: "#PYL0289" },
      data: {
        verificationFailureReason: "player API token did not validate.",
      },
    });
    expect(result).toEqual({
      outcome: "invalid_token",
      playerTag: "#PYL0289",
      discordUserId: "111111111111111111",
      verificationFailureReason: "player API token did not validate.",
    });
  });

  it("does not allow verifying a link owned by another Discord user", async () => {
    prismaMock.playerLink.findUnique.mockResolvedValue({
      discordUserId: "222222222222222222",
    });
    const cocService = {
      verifyPlayerToken: vi.fn(),
    };

    const service = new PlayerLinkVerificationService(cocService as any);
    const result = await service.verifyPlayerToken({
      playerTag: "#pyl0289",
      discordUserId: "111111111111111111",
      token: "TOKEN-123",
    });

    expect(cocService.verifyPlayerToken).not.toHaveBeenCalled();
    expect(result).toEqual({
      outcome: "not_owner",
      playerTag: "#PYL0289",
      discordUserId: "111111111111111111",
    });
  });
});

