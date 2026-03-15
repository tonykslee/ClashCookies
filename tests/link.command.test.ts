import { describe, expect, it } from "vitest";
import { ApplicationCommandOptionType } from "discord.js";
import { Link } from "../src/commands/Link";

describe("/link command shape", () => {
  it("registers create/delete/list subcommands with expected options", () => {
    const create = Link.options?.find(
      (option) =>
        option.type === ApplicationCommandOptionType.Subcommand && option.name === "create"
    );
    const del = Link.options?.find(
      (option) =>
        option.type === ApplicationCommandOptionType.Subcommand && option.name === "delete"
    );
    const list = Link.options?.find(
      (option) =>
        option.type === ApplicationCommandOptionType.Subcommand && option.name === "list"
    );

    expect(create).toBeTruthy();
    expect(del).toBeTruthy();
    expect(list).toBeTruthy();

    expect(create?.options?.find((o: any) => o.name === "player-tag")?.required).toBe(true);
    expect(create?.options?.find((o: any) => o.name === "player-tag")?.type).toBe(
      ApplicationCommandOptionType.String
    );
    expect(create?.options?.find((o: any) => o.name === "user")?.required).toBe(false);

    expect(del?.options?.find((o: any) => o.name === "player-tag")?.required).toBe(true);
    expect(del?.options?.find((o: any) => o.name === "player-tag")?.type).toBe(
      ApplicationCommandOptionType.String
    );

    expect(list?.options?.find((o: any) => o.name === "clan-tag")?.required).toBe(true);
    expect(list?.options?.find((o: any) => o.name === "clan-tag")?.type).toBe(
      ApplicationCommandOptionType.String
    );
    expect(list?.options?.find((o: any) => o.name === "clan-tag")?.autocomplete).toBe(true);
  });
});
