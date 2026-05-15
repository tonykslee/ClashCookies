import { beforeEach, describe, expect, it, vi } from "vitest";
import { EmbedBuilder } from "discord.js";
import { Compo } from "../src/commands/Compo";
import { CompoPlaceService } from "../src/services/CompoPlaceService";
import { GoogleSheetsService } from "../src/services/GoogleSheetsService";
import { emojiResolverService } from "../src/services/emoji/EmojiResolverService";

function makeInteraction(weight: string) {
  const interaction: any = {
    id: "interaction-1",
    commandName: "compo",
    guildId: "guild-1",
    user: { id: "user-1" },
    deferred: false,
    replied: false,
    deferReply: vi.fn(async () => {
      interaction.deferred = true;
    }),
    editReply: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
    options: {
      getSubcommand: vi.fn(() => "place"),
      getString: vi.fn((name: string) => {
        if (name === "weight") return weight;
        return null;
      }),
    },
  };
  return interaction;
}

function captureConsoleLogs() {
  const captured: Array<{ level: "log" | "error" | "info"; text: string }> = [];
  const logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
    captured.push({ level: "log", text: args.map((value) => String(value)).join(" ") });
  });
  const errorSpy = vi.spyOn(console, "error").mockImplementation((...args) => {
    captured.push({ level: "error", text: args.map((value) => String(value)).join(" ") });
  });
  const infoSpy = vi.spyOn(console, "info").mockImplementation((...args) => {
    captured.push({ level: "info", text: args.map((value) => String(value)).join(" ") });
  });
  return { captured, logSpy, errorSpy, infoSpy };
}

function getComponentCustomIds(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const rows = Array.isArray((payload as { components?: unknown[] }).components)
    ? ((payload as { components: unknown[] }).components as unknown[])
    : [];
  return rows.flatMap((row) => {
    const normalized =
      row && typeof (row as { toJSON?: () => unknown }).toJSON === "function"
        ? (row as { toJSON: () => unknown }).toJSON()
        : row;
    if (!normalized || typeof normalized !== "object") return [];
    const components = Array.isArray((normalized as { components?: unknown[] }).components)
      ? ((normalized as { components: unknown[] }).components as unknown[])
      : [];
    return components
      .map((component) =>
        String(
          (component as { custom_id?: unknown; customId?: unknown }).custom_id ??
            (component as { custom_id?: unknown; customId?: unknown }).customId ??
            "",
        ),
      )
      .filter((value) => value.length > 0);
  });
}

function getFirstButtonState(payload: unknown): { label: string; disabled: boolean } | null {
  if (!payload || typeof payload !== "object") return null;
  const rows = Array.isArray((payload as { components?: unknown[] }).components)
    ? ((payload as { components: unknown[] }).components as unknown[])
    : [];
  const firstRow = rows[0];
  const normalized =
    firstRow && typeof (firstRow as { toJSON?: () => unknown }).toJSON === "function"
      ? (firstRow as { toJSON: () => unknown }).toJSON()
      : firstRow;
  if (!normalized || typeof normalized !== "object") return null;
  const firstComponent = Array.isArray((normalized as { components?: unknown[] }).components)
    ? (normalized as { components: unknown[] }).components[0]
    : null;
  if (!firstComponent || typeof firstComponent !== "object") return null;
  return {
    label: String((firstComponent as { label?: unknown }).label ?? ""),
    disabled: Boolean((firstComponent as { disabled?: unknown }).disabled),
  };
}

describe("/compo place command", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the place service, keeps sheet access out of the command layer, and restores the place refresh button", async () => {
    const { captured, logSpy, errorSpy, infoSpy } = captureConsoleLogs();
    const readPlaceSpy = vi
      .spyOn(CompoPlaceService.prototype, "readPlace")
      .mockResolvedValue({
        content: "",
        embeds: [new EmbedBuilder().setTitle("Compo Placement Suggestions")],
        trackedClanTags: ["#AAA111"],
        eligibleClanTags: ["#AAA111"],
        candidateCount: 1,
      recommendedCount: 0,
      vacancyCount: 0,
      compositionCount: 1,
    });
    const fetchEmojiSpy = vi.spyOn(
      emojiResolverService,
      "fetchApplicationEmojiInventory",
    );
    const getCompoLinkedSheetSpy = vi.spyOn(
      GoogleSheetsService.prototype,
      "getCompoLinkedSheet",
    );
    const readCompoLinkedValuesSpy = vi.spyOn(
      GoogleSheetsService.prototype,
      "readCompoLinkedValues",
    );

    const interaction = makeInteraction("145k");
    await Compo.run({} as any, interaction as any, {} as any);

    expect(readPlaceSpy).toHaveBeenCalledWith(145000, "TH15", "guild-1", expect.any(Map));
    expect(fetchEmojiSpy).not.toHaveBeenCalled();
    expect(getCompoLinkedSheetSpy).not.toHaveBeenCalled();
    expect(readCompoLinkedValuesSpy).not.toHaveBeenCalled();

    const payload = interaction.editReply.mock.calls.at(-1)?.[0];
    expect(Array.isArray(payload?.embeds)).toBe(true);
    expect(getComponentCustomIds(payload)).toEqual(["compo-refresh:place:user-1:145000"]);
    expect(getFirstButtonState(payload)).toEqual({
      label: "Refresh Data",
      disabled: false,
    });

    const deferAttemptIndex = captured.findIndex((entry) =>
      entry.text.includes("stage=defer_attempt"),
    );
    const deferSuccessIndex = captured.findIndex((entry) =>
      entry.text.includes("stage=defer_success"),
    );
    const responseSendAttemptIndex = captured.findIndex((entry) =>
      entry.text.includes("stage=response_send_attempt"),
    );
    const responseSentSuccessIndex = captured.findIndex((entry) =>
      entry.text.includes("stage=response_sent_success") &&
      entry.text.includes("method=editReply"),
    );
    const placeReturnSuccessIndex = captured.findIndex((entry) =>
      entry.text.includes("stage=place_return_success"),
    );
    expect(deferAttemptIndex).toBeGreaterThanOrEqual(0);
    expect(deferSuccessIndex).toBeGreaterThanOrEqual(0);
    expect(responseSendAttemptIndex).toBeGreaterThanOrEqual(0);
    expect(responseSentSuccessIndex).toBeGreaterThanOrEqual(0);
    expect(placeReturnSuccessIndex).toBeGreaterThanOrEqual(0);
    expect(deferAttemptIndex).toBeLessThan(deferSuccessIndex);
    expect(deferSuccessIndex).toBeLessThan(responseSendAttemptIndex);
    expect(responseSendAttemptIndex).toBeLessThan(responseSentSuccessIndex);
    expect(responseSentSuccessIndex).toBeLessThan(placeReturnSuccessIndex);

    logSpy.mockRestore();
    errorSpy.mockRestore();
    infoSpy.mockRestore();
  });

  it("maps lower persisted weight buckets into the stable <=TH13 place bucket", async () => {
    const readPlaceSpy = vi
      .spyOn(CompoPlaceService.prototype, "readPlace")
      .mockResolvedValue({
        content: "Mode Displayed: **PLACE**",
        embeds: [],
        trackedClanTags: [],
        eligibleClanTags: [],
        candidateCount: 0,
        recommendedCount: 0,
        vacancyCount: 0,
        compositionCount: 0,
      });
    const fetchEmojiSpy = vi.spyOn(
      emojiResolverService,
      "fetchApplicationEmojiInventory",
    );

    const interaction = makeInteraction("100000");
    await Compo.run({} as any, interaction as any, {} as any);

    expect(readPlaceSpy).toHaveBeenCalledWith(100000, "<=TH13", "guild-1", expect.any(Map));
    expect(fetchEmojiSpy).not.toHaveBeenCalled();
    const payload = interaction.editReply.mock.calls.at(-1)?.[0];
    expect(getComponentCustomIds(payload)).toEqual(["compo-refresh:place:user-1:100000"]);
    expect(getFirstButtonState(payload)).toEqual({
      label: "Refresh Data",
      disabled: false,
    });
  });

  it("logs the raw run_catch error before the fallback response build when place throws", async () => {
    const { captured, logSpy, errorSpy, infoSpy } = captureConsoleLogs();
    const readPlaceSpy = vi
      .spyOn(CompoPlaceService.prototype, "readPlace")
      .mockRejectedValue(new Error("boom"));

    const interaction = makeInteraction("145k");
    await Compo.run({} as any, interaction as any, {} as any);

    expect(readPlaceSpy).toHaveBeenCalled();
    const runEntrySyncIndex = captured.findIndex(
      (entry) =>
        entry.level === "error" &&
        entry.text.includes("stage=run_entry_sync"),
    );
    const runEntryIndex = captured.findIndex(
      (entry) =>
        entry.level === "log" &&
        entry.text.includes("stage=run_entry command="),
    );
    const rawIndex = captured.findIndex(
      (entry) =>
        entry.level === "error" &&
        (entry.text.includes("stage=place_error_raw") ||
          entry.text.includes("stage=run_catch_raw")),
    );
    const fallbackReturnIndex = captured.findIndex(
      (entry) =>
        entry.level === "log" &&
        entry.text.includes("stage=place_return_error_fallback"),
    );
    const fallbackBuildIndex = captured.findIndex(
      (entry) =>
        entry.level === "log" &&
        entry.text.includes("stage=response_build") &&
        entry.text.includes("reason=run_catch"),
    );
    const finallyIndex = captured.findIndex(
      (entry) =>
        entry.level === "log" &&
        entry.text.includes("stage=place_finally"),
    );
    expect(runEntrySyncIndex).toBeGreaterThanOrEqual(0);
    expect(runEntryIndex).toBeGreaterThanOrEqual(0);
    expect(rawIndex).toBeGreaterThanOrEqual(0);
    expect(fallbackReturnIndex).toBeGreaterThanOrEqual(0);
    expect(fallbackBuildIndex).toBeGreaterThanOrEqual(0);
    expect(finallyIndex).toBeGreaterThanOrEqual(0);
    expect(runEntrySyncIndex).toBeLessThan(runEntryIndex);
    expect(runEntryIndex).toBeLessThan(rawIndex);
    expect(rawIndex).toBeLessThan(fallbackBuildIndex);
    expect(fallbackReturnIndex).toBeLessThan(fallbackBuildIndex);
    expect(fallbackBuildIndex).toBeLessThan(finallyIndex);

    logSpy.mockRestore();
    infoSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("logs defer attempt, success, and defer failure details when deferReply rejects", async () => {
    const { captured, logSpy, errorSpy, infoSpy } = captureConsoleLogs();
    const deferError = Object.assign(new Error("defer failed"), {
      name: "DiscordAPIError",
      code: 40060,
      status: 400,
      rawError: { message: "already acknowledged" },
      response: { data: { message: "already acknowledged" } },
      requestBody: { json: { flags: 64 } },
    });
    const readPlaceSpy = vi
      .spyOn(CompoPlaceService.prototype, "readPlace")
      .mockResolvedValue({
        content: "",
        embeds: [new EmbedBuilder().setTitle("Compo Placement Suggestions")],
        trackedClanTags: [],
        eligibleClanTags: [],
        candidateCount: 0,
        recommendedCount: 0,
        vacancyCount: 0,
        compositionCount: 0,
      });

    const interaction = makeInteraction("145k");
    interaction.deferReply.mockRejectedValueOnce(deferError);

    await expect(Compo.run({} as any, interaction as any, {} as any)).rejects.toThrow(
      "defer failed",
    );

    expect(readPlaceSpy).not.toHaveBeenCalled();
    expect(captured.some((entry) => entry.text.includes("stage=defer_attempt"))).toBe(true);
    expect(captured.some((entry) => entry.text.includes("stage=defer_failed"))).toBe(true);
    const attemptIndex = captured.findIndex((entry) => entry.text.includes("stage=defer_attempt"));
    const failedIndex = captured.findIndex((entry) => entry.text.includes("stage=defer_failed"));
    expect(attemptIndex).toBeGreaterThanOrEqual(0);
    expect(failedIndex).toBeGreaterThan(attemptIndex);

    logSpy.mockRestore();
    infoSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("logs response_send_failed_header before the detailed payload dump when editReply rejects", async () => {
    const { captured, logSpy, errorSpy, infoSpy } = captureConsoleLogs();
    const sendError = Object.assign(new Error("embed failure"), {
      name: "DiscordAPIError",
      code: 50035,
      status: 400,
      rawError: {
        message: "Invalid Form Body",
        embeds: { _errors: [{ code: "BASE_TYPE_BAD_LENGTH", message: "too long" }] },
      },
      response: {
        data: {
          message: "Invalid Form Body",
          embeds: { _errors: [{ code: "BASE_TYPE_BAD_LENGTH", message: "too long" }] },
        },
      },
      requestBody: { json: { embeds: [{ title: "Too long" }] } },
    });
    const readPlaceSpy = vi
      .spyOn(CompoPlaceService.prototype, "readPlace")
      .mockResolvedValue({
        content: "",
        embeds: [new EmbedBuilder().setTitle("Compo Placement Suggestions")],
        trackedClanTags: ["#AAA111"],
        eligibleClanTags: ["#AAA111"],
        candidateCount: 1,
        recommendedCount: 0,
        vacancyCount: 0,
        compositionCount: 1,
      });

    const interaction = makeInteraction("145k");
    interaction.editReply.mockRejectedValueOnce(sendError).mockResolvedValueOnce(undefined);

    await Compo.run({} as any, interaction as any, {} as any);

    expect(readPlaceSpy).toHaveBeenCalled();
    const attemptIndex = captured.findIndex((entry) =>
      entry.text.includes("stage=response_send_attempt"),
    );
    const headerIndex = captured.findIndex((entry) =>
      entry.text.includes("stage=response_send_failed_header"),
    );
    const failedIndex = captured.findIndex((entry) =>
      entry.text.includes("stage=response_send_failed") &&
      !entry.text.includes("stage=response_send_failed_header"),
    );
    const fallbackIndex = captured.findIndex((entry) =>
      entry.text.includes("stage=place_return_error_fallback"),
    );
    const buildIndex = captured.findIndex((entry) =>
      entry.text.includes("stage=response_build") &&
      entry.text.includes("reason=run_catch"),
    );
    expect(attemptIndex).toBeGreaterThanOrEqual(0);
    expect(headerIndex).toBeGreaterThan(attemptIndex);
    expect(failedIndex).toBeGreaterThan(headerIndex);
    expect(fallbackIndex).toBeGreaterThan(failedIndex);
    expect(buildIndex).toBeGreaterThan(fallbackIndex);

    logSpy.mockRestore();
    infoSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
