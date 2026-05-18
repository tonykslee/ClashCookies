import { beforeEach, describe, expect, it, vi } from "vitest";
import { Notify } from "../src/commands/Notify";

const prismaMock = vi.hoisted(() => ({
  trackedClan: {
    findMany: vi.fn(),
  },
  clanNotifyConfig: {
    findMany: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

function makeInteraction(input: { clan?: string | null }) {
  return {
    guildId: "guild-1",
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    options: {
      getSubcommand: vi.fn().mockReturnValue("show"),
      getString: vi.fn((name: string, required?: boolean) => {
        if (name === "clan") return input.clan ?? null;
        return required ? null : null;
      }),
      getChannel: vi.fn().mockReturnValue(null),
      getRole: vi.fn().mockReturnValue(null),
      getBoolean: vi.fn().mockReturnValue(null),
    },
  } as any;
}

describe("/notify show", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.trackedClan.findMany.mockResolvedValue([]);
    prismaMock.clanNotifyConfig.findMany.mockResolvedValue([]);
  });

  it("reads the stored bare clanTag for a filtered show request", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      {
        name: "Tracked Clan",
        tag: "#2QVGPQP0U",
      },
    ]);
    prismaMock.clanNotifyConfig.findMany.mockResolvedValue([
      {
        guildId: "guild-1",
        clanTag: "2QVGPQP0U",
        channelId: "channel-1",
        roleId: null,
        embedEnabled: true,
        pingEnabled: true,
        updatedAt: new Date(),
      },
    ]);

    const interaction = makeInteraction({ clan: "#2QVGPQP0U" });

    await Notify.run({} as any, interaction as any, {} as any);

    expect(prismaMock.clanNotifyConfig.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          guildId: "guild-1",
          clanTag: "2QVGPQP0U",
        },
      }),
    );
    expect(interaction.editReply).toHaveBeenCalledTimes(1);
    expect(String(interaction.editReply.mock.calls[0]?.[0] ?? "")).toContain(
      "- **Tracked Clan** (#2QVGPQP0U)",
    );
    expect(String(interaction.editReply.mock.calls[0]?.[0] ?? "")).toContain(
      "Channel: <#channel-1>",
    );
  });

  it("shows configured channels for all tracked clans when no clan filter is provided", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      {
        name: "Tracked Clan One",
        tag: "#2QVGPQP0U",
      },
      {
        name: "Tracked Clan Two",
        tag: "#AAA111",
      },
    ]);
    prismaMock.clanNotifyConfig.findMany.mockResolvedValue([
      {
        guildId: "guild-1",
        clanTag: "2QVGPQP0U",
        channelId: "channel-1",
        roleId: null,
        embedEnabled: true,
        pingEnabled: true,
        updatedAt: new Date(),
      },
      {
        guildId: "guild-1",
        clanTag: "AAA111",
        channelId: "channel-2",
        roleId: "role-1",
        embedEnabled: false,
        pingEnabled: false,
        updatedAt: new Date(),
      },
    ]);

    const interaction = makeInteraction({ clan: null });

    await Notify.run({} as any, interaction as any, {} as any);

    expect(prismaMock.clanNotifyConfig.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { guildId: "guild-1" },
      }),
    );
    const replyText = String(interaction.editReply.mock.calls[0]?.[0] ?? "");
    expect(replyText).toContain("- **Tracked Clan One** (#2QVGPQP0U)");
    expect(replyText).toContain("Channel: <#channel-1>");
    expect(replyText).toContain("- **Tracked Clan Two** (#AAA111)");
    expect(replyText).toContain("Channel: <#channel-2>");
  });
});
