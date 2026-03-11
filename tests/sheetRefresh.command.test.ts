import { beforeEach, describe, expect, it, vi } from "vitest";
import { Sheet } from "../src/commands/Sheet";
import * as SheetRefreshService from "../src/services/SheetRefreshService";

function makeInteraction(mode: "actual" | "war") {
  const interaction: any = {
    commandName: "sheet",
    guildId: "guild-1",
    user: { id: "user-1", tag: "User#0001" },
    deferred: false,
    replied: false,
    deferReply: vi.fn(async () => {
      interaction.deferred = true;
    }),
    editReply: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
    options: {
      getSubcommand: vi.fn(() => "refresh"),
      getString: vi.fn((name: string) => (name === "mode" ? mode : null)),
    },
  };
  return interaction;
}

describe("sheet refresh shared pathway", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("routes /sheet refresh through shared refresh service", async () => {
    vi.spyOn(SheetRefreshService, "triggerSharedSheetRefresh").mockResolvedValue({
      mode: "actual",
      resultText: "OK",
      durationSeconds: "0.12",
    });
    const interaction = makeInteraction("actual");

    await Sheet.run({} as any, interaction as any, {} as any);

    expect(SheetRefreshService.triggerSharedSheetRefresh).toHaveBeenCalledWith({
      guildId: "guild-1",
      mode: "actual",
    });
    const payload = interaction.editReply.mock.calls.at(-1)?.[0];
    expect(String(payload?.content ?? "")).toContain("Refresh triggered for **ACTUAL** mode");
  });
});
