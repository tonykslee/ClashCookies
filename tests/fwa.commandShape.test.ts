import { ApplicationCommandOptionType, ChannelType } from "discord.js";
import { describe, expect, it } from "vitest";
import { Fwa } from "../src/commands/Fwa";

describe("/fwa base-swap command shape", () => {
  it("registers war-bases, base-errors, fwa-bases, swap-reminder, and log-routing options", () => {
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

    const logEnable = baseSwap?.options?.find(
      (option: { name: string }) => option.name === "log-enable",
    );
    expect(logEnable?.type).toBe(ApplicationCommandOptionType.String);
    expect(logEnable?.required).toBe(false);
    expect(logEnable?.choices).toEqual([
      { name: "bot-log channel", value: "bot-log channel" },
      { name: "clan-log channel", value: "clan-log channel" },
      { name: "clan-lead channel", value: "clan-lead channel" },
      { name: "custom", value: "custom" },
      { name: "false", value: "false" },
    ]);

    const channel = baseSwap?.options?.find(
      (option: { name: string }) => option.name === "channel",
    );
    expect(channel?.type).toBe(ApplicationCommandOptionType.Channel);
    expect(channel?.required).toBe(false);
    expect(channel?.channel_types).toEqual([
      ChannelType.GuildText,
      ChannelType.GuildAnnouncement,
      ChannelType.AnnouncementThread,
      ChannelType.PublicThread,
      ChannelType.PrivateThread,
    ]);

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

  it("registers /fwa match-checklist with type and visibility options", () => {
    const checklist = Fwa.options?.find(
      (option) =>
        option.type === ApplicationCommandOptionType.Subcommand &&
        option.name === "match-checklist",
    );
    expect(checklist).toBeTruthy();

    const type = checklist?.options?.find(
      (option: { name: string }) => option.name === "type",
    );
    expect(type?.type).toBe(ApplicationCommandOptionType.String);
    expect(type?.required).toBe(false);
    expect(type?.choices).toEqual([
      { name: "Mail", value: "Mail" },
      { name: "Bases", value: "Bases" },
    ]);
    const visibility = checklist?.options?.find(
      (option: { name: string }) => option.name === "visibility",
    );
    expect(visibility?.type).toBe(ApplicationCommandOptionType.String);
    expect(visibility?.required).toBe(false);
    const clan = checklist?.options?.find(
      (option: { name: string }) => option.name === "clan",
    );
    expect(clan?.type).toBe(ApplicationCommandOptionType.String);
    expect(clan?.required).toBe(false);
    const checked = checklist?.options?.find(
      (option: { name: string }) => option.name === "checked",
    );
    expect(checked?.type).toBe(ApplicationCommandOptionType.Boolean);
    expect(checked?.required).toBe(false);
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

  it("registers /fwa blacklist-samples rebuild as an admin subcommand", () => {
    const blacklistSamples = Fwa.options?.find(
      (option) =>
        option.type === ApplicationCommandOptionType.SubcommandGroup &&
        option.name === "blacklist-samples",
    );
    expect(blacklistSamples).toBeTruthy();

    const rebuild = blacklistSamples?.options?.find(
      (option: { name: string }) => option.name === "rebuild",
    );
    expect(rebuild?.type).toBe(ApplicationCommandOptionType.Subcommand);
    expect(rebuild?.options ?? []).toHaveLength(0);
  });

  it("registers /fwa blacklist-profile rebuild as an admin subcommand", () => {
    const blacklistProfile = Fwa.options?.find(
      (option) =>
        option.type === ApplicationCommandOptionType.SubcommandGroup &&
        option.name === "blacklist-profile",
    );
    expect(blacklistProfile).toBeTruthy();

    const rebuild = blacklistProfile?.options?.find(
      (option: { name: string }) => option.name === "rebuild",
    );
    expect(rebuild?.type).toBe(ApplicationCommandOptionType.Subcommand);
    expect(rebuild?.options ?? []).toHaveLength(0);
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
