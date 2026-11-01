import { ApplicationCommandOptionType } from "discord.js";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const safeReplyMock = vi.hoisted(() => ({
  safeReply: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/helper/safeReply", () => ({
  safeReply: safeReplyMock.safeReply,
}));

import { Potion } from "../src/commands/Potion";
import * as potionCalculatorService from "../src/services/PotionCalculatorService";

function makeInteraction(input: {
  subcommand?: string;
  type?: string | null;
  timeLeft?: string | null;
  numPots?: number | null;
  boostRemaining?: string | null;
  helperLevel?: number | null;
  helperNextIn?: string | null;
}) {
  return {
    options: {
      getSubcommand: vi.fn(() => input.subcommand ?? "calc"),
      getString: vi.fn((name: string) => {
        if (name === "type") return input.type ?? null;
        if (name === "time-left") return input.timeLeft ?? null;
        if (name === "boost-remaining") return input.boostRemaining ?? null;
        if (name === "helper-next-in") return input.helperNextIn ?? null;
        return null;
      }),
      getInteger: vi.fn((name: string) => {
        if (name === "num-pots") return input.numPots ?? null;
        if (name === "helper-level") return input.helperLevel ?? null;
        return null;
      }),
    },
  };
}

function getEmbedData(): any {
  return safeReplyMock.safeReply.mock.calls[0]?.[1]?.embeds?.[0]?.toJSON?.() ?? {};
}

describe("/potion command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("registers the calc subcommand with the expected options and choice values", () => {
    expect(Potion.name).toBe("potion");
    expect(Potion.options).toHaveLength(1);

    const calc = Potion.options?.find(
      (option) =>
        option.type === ApplicationCommandOptionType.Subcommand &&
        option.name === "calc",
    );
    expect(calc).toBeTruthy();
    expect(calc?.options?.map((option: any) => option.name)).toEqual([
      "type",
      "time-left",
      "num-pots",
      "boost-remaining",
      "helper-level",
      "helper-next-in",
    ]);

    const typeOption = calc?.options?.find((option: any) => option.name === "type");
    expect(typeOption?.type).toBe(ApplicationCommandOptionType.String);
    expect(typeOption?.required).toBe(true);
    expect(typeOption?.choices).toEqual([
      { name: "Builder Potion", value: "builder" },
      { name: "Research Potion", value: "research" },
      { name: "Pet Potion", value: "pet" },
      { name: "Clock Tower Potion", value: "clocktower" },
    ]);

    const timeLeftOption = calc?.options?.find((option: any) => option.name === "time-left");
    expect(timeLeftOption?.type).toBe(ApplicationCommandOptionType.String);
    expect(timeLeftOption?.required).toBe(true);

    const numPotsOption = calc?.options?.find((option: any) => option.name === "num-pots");
    expect(numPotsOption?.type).toBe(ApplicationCommandOptionType.Integer);
    expect(numPotsOption?.required).toBe(false);
    expect(numPotsOption?.minValue).toBe(1);
    expect(numPotsOption?.maxValue).toBe(100);

    const boostRemainingOption = calc?.options?.find((option: any) => option.name === "boost-remaining");
    expect(boostRemainingOption?.type).toBe(ApplicationCommandOptionType.String);
    expect(boostRemainingOption?.required).toBe(false);

    const helperLevelOption = calc?.options?.find((option: any) => option.name === "helper-level");
    expect(helperLevelOption?.type).toBe(ApplicationCommandOptionType.Integer);
    expect(helperLevelOption?.required).toBe(false);
    expect(helperLevelOption?.minValue).toBe(1);
    expect(helperLevelOption?.maxValue).toBe(12);

    const helperNextInOption = calc?.options?.find((option: any) => option.name === "helper-next-in");
    expect(helperNextInOption?.type).toBe(ApplicationCommandOptionType.String);
    expect(helperNextInOption?.required).toBe(false);
  });

  it("renders a timestamped result for a valid calc request", async () => {
    const interaction = makeInteraction({
      subcommand: "calc",
      type: "builder",
      timeLeft: "2d6h",
      numPots: 2,
    });

    await Potion.run({} as any, interaction as any, {} as any);

    expect(safeReplyMock.safeReply).toHaveBeenCalledWith(
      interaction,
      expect.objectContaining({ ephemeral: true, embeds: expect.any(Array) }),
    );
    const embed = getEmbedData();
    const expectedUnix = Math.floor(new Date("2026-07-03T00:00:00.000Z").getTime() / 1000);
    expect(embed.title).toBe("Builder Potion Calculator");
    expect(embed.description).toBe("**Finishes in 1d 12h**");
    expect(embed.fields).toEqual(expect.arrayContaining([
      { name: "Completion", value: `<t:${expectedUnix}:F> (<t:${expectedUnix}:R>)`, inline: false },
      { name: "Time saved", value: "18h", inline: true },
      { name: "Original upgrade", value: "2d 6h", inline: true },
      { name: "Potions & boost", value: "2 potions · 10x for 2h", inline: false },
    ]));
    expect(embed.footer.text).toContain("immediate activation");
  });

  it("passes active boost time to the service and renders the active and total windows", async () => {
    const calculateSpy = vi.spyOn(potionCalculatorService, "calculatePotionCompletion");
    const interaction = makeInteraction({
      subcommand: "calc",
      type: "builder",
      timeLeft: "20h",
      numPots: 2,
      boostRemaining: "37m",
    });

    await Potion.run({} as any, interaction as any, {} as any);

    expect(calculateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "builder",
        timeLeft: "20h",
        numPots: 2,
        boostRemaining: "37m",
      }),
    );
    const embed = getEmbedData();
    expect(embed.fields).toContainEqual({
      name: "Active boost",
      value: "Remaining: 37m\nTotal boosted window: 2h 37m",
      inline: true,
    });
    expect(embed.footer.text).toContain("countdowns may vary slightly");
  });

  it("returns the dedicated validation response for invalid boost-remaining", async () => {
    const interaction = makeInteraction({
      subcommand: "calc",
      type: "builder",
      timeLeft: "2h",
      numPots: 1,
      boostRemaining: "0m",
    });

    await Potion.run({} as any, interaction as any, {} as any);

    expect(safeReplyMock.safeReply).toHaveBeenCalledWith(
      interaction,
      expect.objectContaining({
        ephemeral: true,
        content:
          "Invalid boost-remaining. Use a positive duration like 3d12h45m, 12h30m, or 45m.",
      }),
    );
  });

  it("returns an ephemeral validation response for malformed time-left input", async () => {
    const interaction = makeInteraction({
      subcommand: "calc",
      type: "builder",
      timeLeft: "2x",
      numPots: 2,
    });
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await Potion.run({} as any, interaction as any, {} as any);

    expect(safeReplyMock.safeReply).toHaveBeenCalledWith(
      interaction,
      expect.objectContaining({
        ephemeral: true,
        content:
          "Invalid time-left. Use a duration like 3d12h45m, 12h30m, or 45m.",
      }),
    );
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("renders an automatic recommendation when num-pots is omitted", async () => {
    const interaction = makeInteraction({
      subcommand: "calc",
      type: "builder",
      timeLeft: "17h",
    });

    await Potion.run({} as any, interaction as any, {} as any);

    const embed = getEmbedData();
    expect(embed.title).toBe("Builder Potion Calculator");
    expect(embed.description).toBe("**Recommended: 2 additional potions**");
    expect(embed.fields).toContainEqual(expect.objectContaining({
      name: "1 potion (N−1)",
      value: expect.stringContaining("At boost expiry: 7h upgrade time remaining"),
    }));
    expect(embed.fields).toContainEqual(expect.objectContaining({
      name: "2 potions (recommended)",
      value: expect.stringContaining("Completion: 1h 42m"),
    }));
    expect(embed.fields.find((field: any) => field.name === "2 potions (recommended)")?.value)
      .toContain("Unused boost at completion: 18m");
  });

  it("passes helper arguments and renders the recurring helper assumption", async () => {
    const calculateSpy = vi.spyOn(potionCalculatorService, "calculatePotionCompletion");
    const interaction = makeInteraction({
      subcommand: "calc",
      type: "builder",
      timeLeft: "17h",
      numPots: 2,
      helperLevel: 5,
      helperNextIn: "0m",
    });

    await Potion.run({} as any, interaction as any, {} as any);

    expect(calculateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        numPots: 2,
        helperLevel: 5,
        helperNextIn: "0m",
      }),
    );
    const embed = getEmbedData();
    expect(embed.fields).toContainEqual({
      name: "Helper",
      value: "Level 5\nNext work session: 0s",
      inline: true,
    });
  });

  it.each([
    ["builder", "Builder Potion"],
    ["research", "Research Potion"],
    ["pet", "Pet Potion"],
    ["clocktower", "Clock Tower Potion"],
  ])("renders the %s potion type in the embed", async (type, label) => {
    await Potion.run(
      {} as any,
      makeInteraction({ type, timeLeft: "2h", numPots: 1 }) as any,
      {} as any,
    );

    expect(getEmbedData().title).toBe(`${label} Calculator`);
  });

  it("renders a zero-pot recommendation without an N−1 comparison", async () => {
    await Potion.run(
      {} as any,
      makeInteraction({
        type: "builder",
        timeLeft: "1h",
        boostRemaining: "2h",
      }) as any,
      {} as any,
    );

    const embed = getEmbedData();
    expect(embed.description).toBe("**Recommended: 0 additional potions**");
    expect(embed.fields.some((field: any) => field.name.includes("N−1"))).toBe(false);
    expect(embed.fields).toContainEqual(expect.objectContaining({
      name: "0 potions (recommended)",
    }));
  });
});
