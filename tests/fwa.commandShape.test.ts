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

  it("registers /fwa match-checklist with a visibility option", () => {
    const checklist = Fwa.options?.find(
      (option) =>
        option.type === ApplicationCommandOptionType.Subcommand &&
        option.name === "match-checklist",
    );
    expect(checklist).toBeTruthy();

    const visibility = checklist?.options?.find(
      (option: { name: string }) => option.name === "visibility",
    );
    expect(visibility?.type).toBe(ApplicationCommandOptionType.String);
    expect(visibility?.required).toBe(false);
    const tag = checklist?.options?.find(
      (option: { name: string }) => option.name === "tag",
    );
    expect(tag).toBeUndefined();
  });

  it("registers /fwa blacklist-import with tags, source-label, and active options", () => {
    const blacklistImport = Fwa.options?.find(
      (option) =>
        option.type === ApplicationCommandOptionType.Subcommand &&
        option.name === "blacklist-import",
    );
    expect(blacklistImport).toBeTruthy();

    const tags = blacklistImport?.options?.find(
      (option: { name: string }) => option.name === "tags",
    );
    expect(tags?.type).toBe(ApplicationCommandOptionType.String);
    expect(tags?.required).toBe(true);

    const sourceLabel = blacklistImport?.options?.find(
      (option: { name: string }) => option.name === "source-label",
    );
    expect(sourceLabel?.type).toBe(ApplicationCommandOptionType.String);
    expect(sourceLabel?.required).toBe(false);

    const active = blacklistImport?.options?.find(
      (option: { name: string }) => option.name === "active",
    );
    expect(active?.type).toBe(ApplicationCommandOptionType.Boolean);
    expect(active?.required).toBe(false);
  });

  it("does not register checklist on /fwa match as an optional boolean", () => {
    const match = Fwa.options?.find(
      (option) =>
        option.type === ApplicationCommandOptionType.Subcommand &&
        option.name === "match",
    );
    expect(match).toBeTruthy();

    const checklist = match?.options?.find(
      (option: { name: string }) => option.name === "checklist",
    );
    expect(checklist).toBeUndefined();
  });

  it("does not register a standalone mail send subcommand group", () => {
    const mail = Fwa.options?.find(
      (option) => option.type === ApplicationCommandOptionType.SubcommandGroup && option.name === "mail",
    );
    expect(mail).toBeUndefined();
  });
});
