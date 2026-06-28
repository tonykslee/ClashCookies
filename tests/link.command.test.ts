import { describe, expect, it } from "vitest";
import { ApplicationCommandOptionType } from "discord.js";
import { Link } from "../src/commands/Link";

describe("/link command shape", () => {
  it("registers create/delete/verify/status/list/embed/sync-clashperk subcommands with expected options", () => {
    const create = Link.options?.find(
      (option) =>
        option.type === ApplicationCommandOptionType.Subcommand && option.name === "create"
    );
    const del = Link.options?.find(
      (option) =>
        option.type === ApplicationCommandOptionType.Subcommand && option.name === "delete"
    );
    const verify = Link.options?.find(
      (option) =>
        option.type === ApplicationCommandOptionType.Subcommand && option.name === "verify"
    );
    const status = Link.options?.find(
      (option) =>
        option.type === ApplicationCommandOptionType.Subcommand && option.name === "status"
    );
    const list = Link.options?.find(
      (option) =>
        option.type === ApplicationCommandOptionType.Subcommand && option.name === "list"
    );
    const embed = Link.options?.find(
      (option) =>
        option.type === ApplicationCommandOptionType.Subcommand && option.name === "embed"
    );
    const syncClashperk = Link.options?.find(
      (option) =>
        option.type === ApplicationCommandOptionType.Subcommand &&
        option.name === "sync-clashperk"
    );

    expect(create).toBeTruthy();
    expect(del).toBeTruthy();
    expect(verify).toBeTruthy();
    expect(status).toBeTruthy();
    expect(list).toBeTruthy();
    expect(embed).toBeTruthy();
    expect(syncClashperk).toBeTruthy();

    expect(del?.description).toContain("Delete one or more local player-tag links");

    expect(create?.options?.find((o: any) => o.name === "player-tag")?.required).toBe(true);
    expect(create?.options?.find((o: any) => o.name === "player-tag")?.type).toBe(
      ApplicationCommandOptionType.String
    );
    expect(create?.options?.find((o: any) => o.name === "user")?.required).toBe(false);
    expect(create?.options?.find((o: any) => o.name === "user")?.type).toBe(
      ApplicationCommandOptionType.User
    );

    expect(del?.options?.find((o: any) => o.name === "player-tag")?.required).toBe(true);
    expect(del?.options?.find((o: any) => o.name === "player-tag")?.type).toBe(
      ApplicationCommandOptionType.String
    );
    expect(del?.options?.find((o: any) => o.name === "player-tag")?.description).toContain(
      "comma-separated, space-separated, or mixed-separated",
    );

    expect(verify?.options?.find((o: any) => o.name === "player-tag")?.required).toBe(true);
    expect(verify?.options?.find((o: any) => o.name === "player-tag")?.type).toBe(
      ApplicationCommandOptionType.String
    );
    expect(verify?.options?.find((o: any) => o.name === "token")?.required).toBe(true);
    expect(verify?.options?.find((o: any) => o.name === "token")?.type).toBe(
      ApplicationCommandOptionType.String
    );

    expect(status?.options?.find((o: any) => o.name === "player-tag")?.required).toBe(false);
    expect(status?.options?.find((o: any) => o.name === "player-tag")?.type).toBe(
      ApplicationCommandOptionType.String
    );

    expect(list?.options?.find((o: any) => o.name === "clan-tag")?.required).toBe(true);
    expect(list?.options?.find((o: any) => o.name === "clan-tag")?.type).toBe(
      ApplicationCommandOptionType.String
    );
    expect(list?.options?.find((o: any) => o.name === "clan-tag")?.autocomplete).toBe(true);

    expect(embed?.options?.find((o: any) => o.name === "channel")?.required).toBe(true);
    expect(embed?.options?.find((o: any) => o.name === "channel")?.type).toBe(
      ApplicationCommandOptionType.Channel
    );

    expect(syncClashperk?.options?.find((o: any) => o.name === "sheet-url")?.required).toBe(
      true
    );
    expect(syncClashperk?.options?.find((o: any) => o.name === "sheet-url")?.type).toBe(
      ApplicationCommandOptionType.String
    );
  });
});
