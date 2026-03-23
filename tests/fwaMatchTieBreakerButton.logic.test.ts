import { describe, expect, it, vi } from "vitest";
import { handleFwaMatchTieBreakerButton } from "../src/commands/Fwa";
import { buildFwaMatchTieBreakerCustomId } from "../src/commands/fwa/customIds";

describe("fwa match tie-breaker button", () => {
  it("rejects non-requesters", async () => {
    const reply = vi.fn().mockResolvedValue(undefined);
    const interaction = {
      customId: buildFwaMatchTieBreakerCustomId({
        userId: "owner-1",
        key: "payload-1",
        tag: "#ABC123",
      }),
      user: { id: "other-user" },
      reply,
    };

    await handleFwaMatchTieBreakerButton(interaction as any);

    expect(reply).toHaveBeenCalledWith({
      ephemeral: true,
      content: "Only the command requester can use this button.",
    });
  });

  it("replies ephemerally with the tie-breaker image for the requester", async () => {
    const reply = vi.fn().mockResolvedValue(undefined);
    const interaction = {
      customId: buildFwaMatchTieBreakerCustomId({
        userId: "owner-1",
        key: "payload-1",
        tag: "#ABC123",
      }),
      user: { id: "owner-1" },
      reply,
    };

    await handleFwaMatchTieBreakerButton(interaction as any);

    const payload = reply.mock.calls[0]?.[0] as
      | { ephemeral?: boolean; embeds?: Array<{ toJSON?: () => any }> }
      | undefined;
    const firstEmbed = payload?.embeds?.[0];
    const imageUrl =
      typeof firstEmbed?.toJSON === "function"
        ? firstEmbed.toJSON()?.image?.url
        : null;

    expect(payload?.ephemeral).toBe(true);
    expect(imageUrl).toBe("https://i.imgur.com/lvoJgZB.png");
  });
});
