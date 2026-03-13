import { describe, expect, it } from "vitest";
import { ApplicationCommandOptionType } from "discord.js";
import { Fwa } from "../src/commands/Fwa";

describe("/fwa weight subcommands", () => {
  it("registers weight-age, weight-link, weight-health, and weight-cookie subcommands", () => {
    const names = new Set(
      Fwa.options
        ?.filter((option) => option.type === ApplicationCommandOptionType.Subcommand)
        .map((option) => option.name)
    );

    expect(names.has("weight-age")).toBe(true);
    expect(names.has("weight-link")).toBe(true);
    expect(names.has("weight-health")).toBe(true);
    expect(names.has("weight-cookie")).toBe(true);
  });

  it("keeps tag optional for weight-age and weight-link", () => {
    const weightAge = Fwa.options?.find((option) => option.name === "weight-age");
    const weightLink = Fwa.options?.find((option) => option.name === "weight-link");

    const ageTag = weightAge?.options?.find((option) => option.name === "tag");
    const linkTag = weightLink?.options?.find((option) => option.name === "tag");

    expect(ageTag?.required).toBe(false);
    expect(linkTag?.required).toBe(false);
  });

  it("keeps cookie args optional for weight-cookie status flow", () => {
    const weightCookie = Fwa.options?.find((option) => option.name === "weight-cookie");
    const applicationCookie = weightCookie?.options?.find(
      (option) => option.name === "application-cookie"
    );
    const antiforgeryCookie = weightCookie?.options?.find(
      (option) => option.name === "antiforgery-cookie"
    );
    const antiforgeryCookieName = weightCookie?.options?.find(
      (option) => option.name === "antiforgery-cookie-name"
    );

    expect(applicationCookie?.required).toBe(false);
    expect(antiforgeryCookie?.required).toBe(false);
    expect(antiforgeryCookieName?.required).toBe(false);
  });
});

