import { describe, expect, it } from "vitest";
import { ApplicationCommandOptionType } from "discord.js";
import { Fwa } from "../src/commands/Fwa";

describe("/fwa weight subcommands", () => {
  it("registers only the persisted weight subcommands", () => {
    const names = new Set(
      Fwa.options
        ?.filter((option) => option.type === ApplicationCommandOptionType.Subcommand)
        .map((option) => option.name),
    );

    expect(names.has(["weight", "age"].join("-"))).toBe(false);
    expect(names.has("weight-link")).toBe(true);
    expect(names.has("weight-health")).toBe(true);
    expect(names.has("weight-alert")).toBe(true);
    expect(names.has(["weight", "cookie"].join("-"))).toBe(false);
  });

  it("keeps tag optional for weight-link and weight-health and requires it for alerts", () => {
    for (const name of ["weight-link", "weight-health"]) {
      const option = Fwa.options?.find((candidate) => candidate.name === name);
      expect(option?.options?.find((candidate) => candidate.name === "tag")?.required).toBe(false);
    }
    const alert = Fwa.options?.find((candidate) => candidate.name === "weight-alert");
    expect(alert?.options?.find((candidate) => candidate.name === "tag")?.required).toBe(true);
    expect(alert?.options?.find((candidate) => candidate.name === "after-days")?.min_value).toBe(1);
    expect(alert?.options?.find((candidate) => candidate.name === "after-days")?.max_value).toBe(365);
  });
});
