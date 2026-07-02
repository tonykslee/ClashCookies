import { describe, expect, it, vi, beforeEach } from "vitest";

const prismaMock = vi.hoisted(() => ({
  trackedClan: {
    findMany: vi.fn(),
  },
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

import { getTrackedClanAutocompleteChoices } from "../src/services/TrackedClanAutocompleteService";

function makeValidTrackedClanTag(index: number): string {
  const alphabet = "PYLQGRJCUV0289";
  let value = Math.trunc(index);
  let suffix = "";
  for (let i = 0; i < 4; i += 1) {
    suffix = (alphabet[value % alphabet.length] ?? alphabet[0]) + suffix;
    value = Math.floor(value / alphabet.length);
  }
  return `PYLQ${suffix}`;
}

describe("TrackedClanAutocompleteService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ranks exact tag matches before prefix and name matches with canonical #TAG values", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue([
      { name: "Exact Pylq", tag: "pylq" },
      { name: "Prefix Clan", tag: "#PYLQ0289" },
      { name: "Prefix Clan", tag: "#PYLQ0C89" },
      { name: "Pylq Raiders", tag: "#R80L8VYG" },
      { name: "Invalid", tag: "bad-tag" },
    ]);

    const choices = await getTrackedClanAutocompleteChoices({
      focusedText: "pylq",
      limit: 25,
    });

    expect(prismaMock.trackedClan.findMany).toHaveBeenCalledWith({
      orderBy: { createdAt: "asc" },
      select: { name: true, tag: true },
    });
    expect(choices).toEqual([
      { name: "Exact Pylq (#PYLQ)", value: "#PYLQ" },
      { name: "Prefix Clan (#PYLQ0289)", value: "#PYLQ0289" },
      { name: "Prefix Clan (#PYLQ0C89)", value: "#PYLQ0C89" },
      { name: "Pylq Raiders (#R80L8VYG)", value: "#R80L8VYG" },
    ]);
  });

  it("matches leading # in tag searches and keeps the result limit capped at 25", async () => {
    prismaMock.trackedClan.findMany.mockResolvedValue(
      Array.from({ length: 30 }, (_value, index) => ({
        name: `Clan ${index + 1}`,
        tag: makeValidTrackedClanTag(index),
      })),
    );

    const tagChoices = await getTrackedClanAutocompleteChoices({
      focusedText: "#pylq",
      limit: 25,
    });
    const maxChoices = await getTrackedClanAutocompleteChoices({
      focusedText: "",
      limit: 30,
    });

    expect(tagChoices).toHaveLength(25);
    expect(maxChoices).toHaveLength(25);
    expect(tagChoices[0]?.value).toMatch(/^#PYLQ/);
    expect(maxChoices[0]?.value).toMatch(/^#PYLQ/);
  });
});
