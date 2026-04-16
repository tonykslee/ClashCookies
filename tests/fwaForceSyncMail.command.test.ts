import { afterEach, describe, expect, it, vi } from "vitest";
import {
  persistActiveWarMailLifecycleForTest,
  runForceSyncMailCommand,
} from "../src/commands/Fwa";
import { prisma } from "../src/prisma";
import { WarMailLifecycleService } from "../src/services/WarMailLifecycleService";
import { PointsSyncService } from "../src/services/PointsSyncService";

function buildMessage(input?: {
  clanTag?: string;
  warId?: string;
  opponentTag?: string;
  messageId?: string;
  channelId?: string;
  authorId?: string;
}) {
  const clanTag = input?.clanTag ?? "R80L8VYG";
  const warId = input?.warId ?? "1000110";
  const opponentTag = input?.opponentTag ?? "2Q0PL9GRJ";
  return {
    id: input?.messageId ?? "1485883255436611624",
    channelId: input?.channelId ?? "mail-channel-1",
    author: { id: input?.authorId ?? "bot-1" },
    embeds: [
      {
        title: `Event: Battle Day - DARK EMPIRE (#${clanTag})`,
        footer: { text: `War ID: ${warId}` },
        fields: [{ name: "Opponent", value: `DARK WINGS (#${opponentTag})` }],
      },
    ],
  };
}

function createInteraction(input?: {
  fetchMessage?: ReturnType<typeof vi.fn>;
  messageId?: string;
}) {
  const fetchMessage = input?.fetchMessage ?? vi.fn();
  const editReply = vi.fn().mockResolvedValue(undefined);
  return {
    guildId: "guild-1",
    channelId: "mail-channel-1",
    channel: {
      id: "mail-channel-1",
      isTextBased: () => true,
      messages: {
        fetch: fetchMessage,
      },
    },
    client: {
      user: { id: "bot-1" },
    },
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply,
    options: {
      getString: vi.fn((name: string) => {
        if (name === "visibility") return null;
        if (name === "tag") return "R80L8VYG";
        if (name === "message_id") return input?.messageId ?? "1485883255436611624";
        if (name === "message_type") return "mail";
        return null;
      }),
    },
  } as any;
}

describe("runForceSyncMailCommand", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects mail lifecycle repair when supplied message identity mismatches active war", async () => {
    vi.spyOn(prisma.trackedClan, "findFirst").mockResolvedValueOnce({
      tag: "#R80L8VYG",
      name: "DARK EMPIRE",
    } as never);
    vi.spyOn(prisma.currentWar, "findUnique").mockResolvedValueOnce({
      warId: 1000110,
      matchType: "FWA",
      outcome: "WIN",
      startTime: new Date("2026-03-25T04:22:17.000Z"),
      opponentTag: "#2Q0PL9GRJ",
    } as never);
    const trackedClanUpdateSpy = vi.spyOn(prisma.trackedClan, "update");
    const lifecycleMarkPostedSpy = vi.spyOn(
      WarMailLifecycleService.prototype,
      "markPosted",
    );
    const interaction = createInteraction({
      fetchMessage: vi.fn().mockResolvedValue(
        buildMessage({
          warId: "1000999",
        }),
      ),
    });
    const cocService = {
      getCurrentWar: vi.fn().mockResolvedValue({
        opponent: { tag: "#2Q0PL9GRJ" },
        startTime: "20260325T042217.000Z",
      }),
    } as any;

    await runForceSyncMailCommand(interaction, cocService);

    const reply = String(interaction.editReply.mock.calls[0]?.[0] ?? "");
    expect(reply).toContain("Could not sync active-war mail reference");
    expect(reply).toContain("Validation failed:");
    expect(lifecycleMarkPostedSpy).not.toHaveBeenCalled();
    expect(trackedClanUpdateSpy).not.toHaveBeenCalled();
  });

  it("accepts validated active-war mail reference and persists lifecycle as posted", async () => {
    vi.spyOn(prisma.trackedClan, "findFirst").mockResolvedValueOnce({
      tag: "#R80L8VYG",
      name: "DARK EMPIRE",
    } as never);
    vi.spyOn(prisma.currentWar, "findUnique").mockResolvedValueOnce({
      warId: 1000110,
      matchType: "FWA",
      outcome: "WIN",
      startTime: new Date("2026-03-25T04:22:17.000Z"),
      opponentTag: "#2Q0PL9GRJ",
    } as never);
    vi.spyOn(prisma.trackedClan, "findUnique").mockResolvedValueOnce({
      mailConfig: null,
    } as never);
    vi.spyOn(prisma.trackedClan, "update").mockResolvedValueOnce({} as never);
    vi.spyOn(PointsSyncService.prototype, "getCurrentSyncForClan").mockResolvedValue(
      null as never,
    );
    vi.spyOn(PointsSyncService.prototype, "markConfirmedByClanMail").mockResolvedValue(
      undefined,
    );
    const lifecycleMarkPostedSpy = vi
      .spyOn(WarMailLifecycleService.prototype, "markPosted")
      .mockResolvedValueOnce(undefined);
    const interaction = createInteraction({
      fetchMessage: vi.fn().mockResolvedValue(buildMessage()),
    });
    const cocService = {
      getCurrentWar: vi.fn().mockResolvedValue({
        opponent: { tag: "#2Q0PL9GRJ" },
        startTime: "20260325T042217.000Z",
      }),
    } as any;

    await runForceSyncMailCommand(interaction, cocService);

    expect(lifecycleMarkPostedSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "guild-1",
        clanTag: "R80L8VYG",
        warId: 1000110,
        warStartTime: new Date("2026-03-25T04:22:17.000Z"),
        opponentTag: "2Q0PL9GRJ",
        channelId: "mail-channel-1",
        messageId: "1485883255436611624",
      }),
    );
    const reply = String(interaction.editReply.mock.calls[0]?.[0] ?? "");
    expect(reply).toContain("Validation: tracked message exists in this channel and matches active-war identity.");
    expect(reply).toContain("Mail lifecycle saved in **WarMailLifecycle**.");
  });

  it("persists active-war lifecycle writes with warStartTime-scoped identity", async () => {
    const markPostedSpy = vi
      .spyOn(WarMailLifecycleService.prototype, "markPosted")
      .mockResolvedValueOnce(undefined);

    await persistActiveWarMailLifecycleForTest({
      guildId: "guild-1",
      clanTag: "R80L8VYG",
      warId: 1000110,
      warStartTime: new Date("2026-03-25T04:22:17.000Z"),
      opponentTag: "2Q0PL9GRJ",
      channelId: "mail-channel-1",
      messageId: "1485883255436611624",
    });

    expect(markPostedSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "guild-1",
        clanTag: "R80L8VYG",
        warId: 1000110,
        warStartTime: new Date("2026-03-25T04:22:17.000Z"),
        opponentTag: "2Q0PL9GRJ",
        channelId: "mail-channel-1",
        messageId: "1485883255436611624",
      }),
    );
  });
});

