import { ApplicationCommandOptionType } from "discord.js";
import { describe, expect, it } from "vitest";
import { Fwa } from "../src/commands/Fwa";

describe("/fwa base-swap command shape", () => {
  it("registers war-bases, base-errors, fwa-bases, and swap-reminder options", () => {
    const baseSwap = Fwa.options?.find(
      (option) =>
        option.type === ApplicationCommandOptionType.Subcommand &&
        option.name === "base-swap",
    );
    expect(baseSwap).toBeTruthy();

    const warBases = baseSwap?.options?.find(
      (option: { name: string }) => option.name === "war-bases",
    );
    expect(warBases?.type).toBe(ApplicationCommandOptionType.String);
    expect(warBases?.required).toBe(false);

    const baseErrors = baseSwap?.options?.find(
      (option: { name: string }) => option.name === "base-errors",
    );
    expect(baseErrors?.type).toBe(ApplicationCommandOptionType.String);
    expect(baseErrors?.required).toBe(false);

    const fwaBases = baseSwap?.options?.find(
      (option: { name: string }) => option.name === "fwa-bases",
    );
    expect(fwaBases?.type).toBe(ApplicationCommandOptionType.String);
    expect(fwaBases?.required).toBe(false);
    expect(fwaBases?.description).toContain("blacklist-war swap");

    const swapReminder = baseSwap?.options?.find(
      (option: { name: string }) => option.name === "swap-reminder",
    );
    expect(swapReminder?.type).toBe(ApplicationCommandOptionType.Boolean);
    expect(swapReminder?.required).toBe(false);
  });
});
