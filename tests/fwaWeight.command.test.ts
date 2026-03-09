import { describe, expect, it } from "vitest";
import { ApplicationCommandOptionType } from "discord.js";
import { Fwa } from "../src/commands/Fwa";

describe("/fwa weight subcommands", () => {
  it("registers weight-age, weight-link, and weight-health subcommands", () => {
    const names = new Set(
      Fwa.options
        ?.filter((option) => option.type === ApplicationCommandOptionType.Subcommand)
        .map((option) => option.name)
    );

    expect(names.has("weight-age")).toBe(true);
    expect(names.has("weight-link")).toBe(true);
    expect(names.has("weight-health")).toBe(true);
  });

  it("keeps tag optional for weight-age and weight-link", () => {
    const weightAge = Fwa.options?.find((option) => option.name === "weight-age");
    const weightLink = Fwa.options?.find((option) => option.name === "weight-link");

    const ageTag = weightAge?.options?.find((option) => option.name === "tag");
    const linkTag = weightLink?.options?.find((option) => option.name === "tag");

    expect(ageTag?.required).toBe(false);
    expect(linkTag?.required).toBe(false);
  });
});

