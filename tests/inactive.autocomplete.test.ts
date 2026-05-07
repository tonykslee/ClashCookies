import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  trackedClan: {
    findMany: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import { Inactive } from "../src/commands/Inactive";

function makeAutocompleteInteraction(query: string) {
  const respond = vi.fn().mockResolvedValue(undefined);
  return {
    options: {
      getFocused: vi.fn(() => ({ name: "clan", value: query })),
    },
    respond,
  };
}

describe("/inactive autocomplete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns tracked FWA clan choices in the same label style as tracked-clan autocomplete", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { name: "Alpha", tag: "#PYLQ0289" },
      { name: "Bravo", tag: "#QGRJ2222" },
    ]);
    const interaction = makeAutocompleteInteraction("alp");

    await Inactive.autocomplete?.(interaction as any);

    expect(interaction.respond).toHaveBeenCalledWith([
      { name: "Alpha (#PYLQ0289)", value: "#PYLQ0289" },
    ]);
  });
});
