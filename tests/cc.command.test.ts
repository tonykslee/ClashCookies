import { beforeEach, describe, expect, it, vi } from "vitest";

const safeReplyMock = vi.hoisted(() => ({
  safeReply: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/helper/safeReply", () => ({
  safeReply: safeReplyMock.safeReply,
}));

import { CC } from "../src/commands/CC";

function makeInteraction(subcommand: string, tag: string) {
  return {
    options: {
      getSubcommand: vi.fn(() => subcommand),
      getString: vi.fn((name: string) => (name === "tag" ? tag : null)),
    },
  };
}

describe("/cc command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("builds player URLs with O folded into 0", async () => {
    const interaction = makeInteraction("player", "POYLGQ");

    await CC.run({} as any, interaction as any, {} as any);

    expect(safeReplyMock.safeReply).toHaveBeenCalledWith(
      interaction,
      expect.objectContaining({
        content: "https://cc.fwafarm.com/cc_n/member.php?tag=P0YLGQ",
      }),
    );
  });

  it("builds clan URLs with O folded into 0", async () => {
    const interaction = makeInteraction("clan", "#poylgq");

    await CC.run({} as any, interaction as any, {} as any);

    expect(safeReplyMock.safeReply).toHaveBeenCalledWith(
      interaction,
      expect.objectContaining({
        content: "https://cc.fwafarm.com/cc_n/clan.php?tag=P0YLGQ",
      }),
    );
  });
});
