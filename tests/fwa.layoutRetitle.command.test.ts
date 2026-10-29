import { describe, expect, it, vi } from "vitest";
import {
  formatFwaLayoutRetitleSummaryForTest,
  runFwaLayoutRetitleCommand,
} from "../src/commands/fwa/layoutRetitleCommand";
import { formatFwaLayoutTitle } from "../src/services/FwaLayoutTitle";

const LINK = "https://link.clashofclans.com/en?action=OpenLayout&id=TH18%3AWB%3ARETITLE";

function buildRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "layout-1",
    layoutLink: LINK,
    title: "Old FWA title",
    description: "Keep this description",
    imageUrl: null,
    postedByDiscordUserId: "poster-1",
    discordGuildId: "guild-1",
    discordChannelId: "channel-1",
    discordMessageId: "message-1",
    submittedAt: new Date("2026-08-01T00:00:00.000Z"),
    lastConfirmedAt: new Date("2026-08-20T00:00:00.000Z"),
    lastConfirmedByDiscordUserId: "confirmer-1",
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-20T00:00:00.000Z"),
    ...overrides,
  };
}

function buildRow(
  record: ReturnType<typeof buildRecord> | null = buildRecord(),
  overrides: Record<string, unknown> = {},
) {
  return {
    Townhall: 18,
    Type: "RISINGDAWN",
    LayoutLink: LINK,
    ImageUrl: null,
    LastUpdated: new Date("2026-08-20T00:00:00.000Z"),
    layoutId: record?.id ?? null,
    layoutRecord: record,
    ...overrides,
  };
}

function makeInteraction(input: { admin?: boolean; type?: string | null } = {}) {
  const reply = vi.fn().mockResolvedValue(undefined);
  const deferReply = vi.fn().mockResolvedValue(undefined);
  const editReply = vi.fn().mockResolvedValue(undefined);
  return {
    interaction: {
      guildId: "guild-1",
      guild: {},
      user: { id: "admin-1" },
      memberPermissions: { has: vi.fn(() => input.admin ?? true) },
      client: { user: { id: "bot-1" } },
      deferReply,
      editReply,
      reply,
      options: {
        getString: vi.fn(() => input.type ?? null),
      },
    } as any,
    reply,
    deferReply,
    editReply,
  };
}

function buildMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: "message-1",
    author: { id: "bot-1" },
    editable: true,
    embeds: [{ title: "Old FWA title" }],
    edit: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("/fwa layout-retitle", () => {
  it("uses the standard title mapping for every FWA type", () => {
    expect(formatFwaLayoutTitle("RISINGDAWN", 18)).toBe("TH18 - R");
    expect(formatFwaLayoutTitle("BASIC", 12)).toBe("TH12 - BASIC");
    expect(formatFwaLayoutTitle("ICE", 10)).toBe("TH10 - ICE");
  });

  it("updates the shared title and edits the existing post without creating a message", async () => {
    const record = buildRecord();
    const message = buildMessage();
    const updatePresentation = vi.fn().mockResolvedValue({ ...record, title: "TH18 - R" });
    const publish = vi.fn().mockResolvedValue({
      layout: { ...record, title: "TH18 - R" },
      messageId: record.discordMessageId,
      jumpUrl: "https://discord.com/channels/guild-1/channel-1/message-1",
    });
    const { interaction, editReply } = makeInteraction();

    await runFwaLayoutRetitleCommand(interaction, {
      layoutService: { listCanonical: vi.fn().mockResolvedValue([buildRow(record)]) },
      presentationService: { updatePresentation },
      publicationService: { publish },
      messageResolver: { resolve: vi.fn().mockResolvedValue(message) },
    });

    expect(updatePresentation).toHaveBeenCalledWith("layout-1", { title: "TH18 - R" });
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      layout: expect.objectContaining({ title: "TH18 - R" }),
      guildId: "guild-1",
      channel: expect.objectContaining({ id: "channel-1" }),
    }));
    expect(editReply.mock.calls[0]?.[0].content).toContain("Updated 1 · Skipped 0 · Failed 0");
  });

  it("is idempotent when both persistence and the existing embed already use the standard title", async () => {
    const record = buildRecord({ title: "TH18 - R" });
    const message = buildMessage({ embeds: [{ title: "TH18 - R" }] });
    const updatePresentation = vi.fn();
    const publish = vi.fn();
    const { interaction, editReply } = makeInteraction();

    await runFwaLayoutRetitleCommand(interaction, {
      layoutService: { listCanonical: vi.fn().mockResolvedValue([buildRow(record)]) },
      presentationService: { updatePresentation },
      publicationService: { publish },
      messageResolver: { resolve: vi.fn().mockResolvedValue(message) },
    });

    expect(updatePresentation).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(editReply.mock.calls[0]?.[0].content).toContain("Updated 0 · Skipped 1 · Failed 0");
    expect(editReply.mock.calls[0]?.[0].content).toContain("already_standard");
  });

  it.each([
    ["missing provenance", buildRecord({ discordMessageId: null }), null, "unpublished"],
    ["inaccessible", buildRecord(), null, "source_inaccessible"],
    ["non-bot authored", buildRecord(), buildMessage({ author: { id: "human-1" } }), "not_bot_authored"],
    ["non-editable", buildRecord(), buildMessage({ editable: false }), "not_editable"],
  ])("skips %s without mutating persistence", async (_label, record, message, reason) => {
    const updatePresentation = vi.fn();
    const publish = vi.fn();
    const { interaction, editReply } = makeInteraction();

    await runFwaLayoutRetitleCommand(interaction, {
      layoutService: { listCanonical: vi.fn().mockResolvedValue([buildRow(record as any)]) },
      presentationService: { updatePresentation },
      publicationService: { publish },
      messageResolver: { resolve: vi.fn().mockResolvedValue(message) },
    });

    expect(updatePresentation).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(editReply.mock.calls[0]?.[0].content).toContain(String(reason));
  });

  it("reports shared records with conflicting standard titles without overwriting either designation", async () => {
    const record = buildRecord();
    const updatePresentation = vi.fn();
    const publish = vi.fn();
    const { interaction, editReply } = makeInteraction();

    await runFwaLayoutRetitleCommand(interaction, {
      layoutService: {
        listCanonical: vi.fn().mockResolvedValue([
          buildRow(record, { Type: "RISINGDAWN", Townhall: 18 }),
          buildRow(record, { Type: "BASIC", Townhall: 18 }),
        ]),
      },
      presentationService: { updatePresentation },
      publicationService: { publish },
      messageResolver: { resolve: vi.fn() },
    });

    expect(updatePresentation).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(editReply.mock.calls[0]?.[0].content).toContain("Skipped 2");
    expect(editReply.mock.calls[0]?.[0].content).toContain("title_conflict");
    expect(editReply.mock.calls[0]?.[0].content).toContain("TH18 BASIC");
  });

  it("detects a shared-record conflict even when only RISINGDAWN was selected", async () => {
    const record = buildRecord();
    const updatePresentation = vi.fn();
    const publish = vi.fn();
    const { interaction, editReply } = makeInteraction({ type: "RISINGDAWN" });
    const listCanonical = vi.fn().mockResolvedValue([
      buildRow(record, { Type: "RISINGDAWN", Townhall: 18 }),
      buildRow(record, { Type: "BASIC", Townhall: 18 }),
    ]);

    await runFwaLayoutRetitleCommand(interaction, {
      layoutService: { listCanonical },
      presentationService: { updatePresentation },
      publicationService: { publish },
      messageResolver: { resolve: vi.fn() },
    });

    expect(listCanonical).toHaveBeenCalledWith();
    expect(updatePresentation).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(editReply.mock.calls[0]?.[0].content).toContain("Skipped 1");
    expect(editReply.mock.calls[0]?.[0].content).toContain("TH18 RISINGDAWN (title_conflict)");
    expect(editReply.mock.calls[0]?.[0].content).not.toContain("TH18 BASIC");
  });

  it("updates a unique record when RISINGDAWN is selected", async () => {
    const record = buildRecord();
    const updatePresentation = vi.fn().mockResolvedValue({ ...record, title: "TH18 - R" });
    const publish = vi.fn().mockResolvedValue({ messageId: "message-1" });
    const { interaction, editReply } = makeInteraction({ type: "RISINGDAWN" });
    const message = buildMessage();

    await runFwaLayoutRetitleCommand(interaction, {
      layoutService: { listCanonical: vi.fn().mockResolvedValue([buildRow(record)]) },
      presentationService: { updatePresentation },
      publicationService: { publish },
      messageResolver: { resolve: vi.fn().mockResolvedValue(message) },
    });

    expect(updatePresentation).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(editReply.mock.calls[0]?.[0].content).toContain("Updated 1 · Skipped 0 · Failed 0");
  });

  it("processes a shared record once when every associated designation has the same title", async () => {
    const record = buildRecord();
    const updatePresentation = vi.fn().mockResolvedValue({ ...record, title: "TH18 - R" });
    const publish = vi.fn().mockResolvedValue({ messageId: "message-1" });
    const { interaction, editReply } = makeInteraction();
    const row = buildRow(record);

    await runFwaLayoutRetitleCommand(interaction, {
      layoutService: { listCanonical: vi.fn().mockResolvedValue([row, { ...row }]) },
      presentationService: { updatePresentation },
      publicationService: { publish },
      messageResolver: { resolve: vi.fn().mockResolvedValue(buildMessage()) },
    });

    expect(updatePresentation).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(editReply.mock.calls[0]?.[0].content).toContain("Updated 2 · Skipped 0 · Failed 0");
  });

  it("remains retryable after the database title write succeeds but Discord editing fails", async () => {
    let currentRecord = buildRecord();
    const message = buildMessage();
    const updatePresentation = vi.fn().mockImplementation(async () => {
      currentRecord = { ...currentRecord, title: "TH18 - R" };
      return currentRecord;
    });
    const publish = vi.fn()
      .mockRejectedValueOnce(new Error("Discord edit unavailable"))
      .mockResolvedValueOnce({ layout: currentRecord, messageId: "message-1", jumpUrl: "https://discord.com/channels/guild-1/channel-1/message-1" });
    const listCanonical = vi.fn().mockImplementation(async () => [buildRow(currentRecord)]);
    const { interaction: first, editReply: firstEdit } = makeInteraction();
    await runFwaLayoutRetitleCommand(first, {
      layoutService: { listCanonical },
      presentationService: { updatePresentation },
      publicationService: { publish },
      messageResolver: { resolve: vi.fn().mockResolvedValue(message) },
    });
    expect(firstEdit.mock.calls[0]?.[0].content).toContain("Failed 1");

    const { interaction: second, editReply: secondEdit } = makeInteraction();
    await runFwaLayoutRetitleCommand(second, {
      layoutService: { listCanonical },
      presentationService: { updatePresentation },
      publicationService: { publish },
      messageResolver: { resolve: vi.fn().mockResolvedValue(message) },
    });
    expect(publish).toHaveBeenCalledTimes(2);
    expect(secondEdit.mock.calls[0]?.[0].content).toContain("Updated 1 · Skipped 0 · Failed 0");
  });

  it("rejects non-administrators before deferring", async () => {
    const { interaction, deferReply, reply } = makeInteraction({ admin: false });
    await runFwaLayoutRetitleCommand(interaction, { layoutService: { listCanonical: vi.fn() } });
    expect(deferReply).not.toHaveBeenCalled();
    expect(reply.mock.calls[0]?.[0].content).toContain("Only administrators");
  });

  it("keeps retitle summaries bounded while naming affected TH/type rows", () => {
    const summary = formatFwaLayoutRetitleSummaryForTest({
      updated: 0,
      skipped: 100,
      failed: 100,
      skippedItems: Array.from({ length: 100 }, (_, index) => ({ townhall: 8 + (index % 11), type: "ICE", reason: "source_inaccessible" })),
      failedItems: Array.from({ length: 100 }, (_, index) => ({ townhall: 8 + (index % 11), type: "BASIC", reason: "discord_edit_failed" })),
    }, null);
    expect(summary.length).toBeLessThanOrEqual(1900);
    expect(summary).toContain("TH8 ICE");
  });
});
