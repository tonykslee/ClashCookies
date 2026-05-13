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

    const clan = baseSwap?.options?.find(
      (option: { name: string }) => option.name === "clan",
    );
    expect(clan?.description).toContain("FWA");
    expect(clan?.description).toContain("CWL");
  });

  it("registers copy_paste on /fwa match as an optional boolean", () => {
    const match = Fwa.options?.find(
      (option) =>
        option.type === ApplicationCommandOptionType.Subcommand &&
        option.name === "match",
    );
    expect(match).toBeTruthy();

    const copyPaste = match?.options?.find(
      (option: { name: string }) => option.name === "copy_paste",
    );
    expect(copyPaste?.type).toBe(ApplicationCommandOptionType.Boolean);
    expect(copyPaste?.required).toBe(false);
  });

  it("does not register a standalone mail send subcommand group", () => {
    const mail = Fwa.options?.find(
      (option) => option.type === ApplicationCommandOptionType.SubcommandGroup && option.name === "mail",
    );
    expect(mail).toBeUndefined();
  });
});
