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
}) {
  return {
    options: {
      getSubcommand: vi.fn(() => input.subcommand ?? "calc"),
      getString: vi.fn((name: string) => {
        if (name === "type") return input.type ?? null;
        if (name === "time-left") return input.timeLeft ?? null;
        if (name === "boost-remaining") return input.boostRemaining ?? null;
        return null;
      }),
      getInteger: vi.fn((name: string) => {
        if (name === "num-pots") return input.numPots ?? null;
        return null;
      }),
    },
  };
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
    expect(numPotsOption?.required).toBe(true);
    expect(numPotsOption?.minValue).toBe(1);
    expect(numPotsOption?.maxValue).toBe(100);

    const boostRemainingOption = calc?.options?.find((option: any) => option.name === "boost-remaining");
    expect(boostRemainingOption?.type).toBe(ApplicationCommandOptionType.String);
    expect(boostRemainingOption?.required).toBe(false);
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
      expect.objectContaining({
        ephemeral: true,
        content: expect.stringContaining("**Potion Calculator**"),
      }),
    );

    const content = String(safeReplyMock.safeReply.mock.calls[0]?.[1]?.content ?? "");
    expect(content).toContain("Type: **Builder Potion**");
    expect(content).toContain("Original time left: **2d 6h**");
    expect(content).toContain("Boost applied: **2 potions");
    expect(content).toContain("10x for 2h");
    expect(content).toContain("Completes in: **1d 12h**");
    expect(content).toContain("Time saved: **18h**");
    expect(content).not.toContain("Approximation:");

    const expectedUnix = Math.floor(new Date("2026-07-03T00:00:00.000Z").getTime() / 1000);
    expect(content).toContain(`Completion time: <t:${expectedUnix}:F> (<t:${expectedUnix}:R>)`);
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
    const content = String(safeReplyMock.safeReply.mock.calls[0]?.[1]?.content ?? "");
    expect(content).toContain("Current boost remaining: **37m**");
    expect(content).toContain("Total boosted window: **2h 37m**");
    expect(content).toContain("Approximation: in-game time-left decreases rapidly while boosted");
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
});
