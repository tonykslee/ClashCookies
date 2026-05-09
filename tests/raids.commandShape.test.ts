import { ApplicationCommandOptionType } from "discord.js";
import { describe, expect, it } from "vitest";
import { Raids } from "../src/commands/Raids";

describe("/raids command shape", () => {
  it("registers an overview subcommand with optional clan autocomplete", () => {
    expect(Raids.name).toBe("raids");
    expect(Raids.options).toHaveLength(1);

    const overview = Raids.options?.find((option) => option.name === "overview");
    expect(overview?.type).toBe(ApplicationCommandOptionType.Subcommand);
    const clan = overview?.options?.find((option) => option.name === "clan");
    expect(clan?.type).toBe(ApplicationCommandOptionType.String);
    expect(clan?.required).toBe(false);
    expect(clan?.autocomplete).toBe(true);
  });
});
