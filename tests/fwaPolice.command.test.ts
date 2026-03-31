import { describe, expect, it } from "vitest";
import { ApplicationCommandOptionType } from "discord.js";
import { Fwa } from "../src/commands/Fwa";

describe("/fwa police command shape", () => {
  it("registers police status with optional clan and keeps clan-required template tooling", () => {
    const police = Fwa.options?.find(
      (option) =>
        option.type === ApplicationCommandOptionType.SubcommandGroup &&
        option.name === "police",
    );
    expect(police).toBeTruthy();

    const allPoliceSubcommands = (police?.options ?? []) as Array<{
      name: string;
      options?: Array<{ name: string; required?: boolean; type?: number; autocomplete?: boolean }>;
    }>;
    for (const sub of allPoliceSubcommands) {
      if (sub.name === "status") continue;
      const clanOption = sub.options?.find((option) => option.name === "clan");
      expect(clanOption?.required).toBe(true);
      expect(clanOption?.type).toBe(ApplicationCommandOptionType.String);
      expect(clanOption?.autocomplete).toBe(true);
    }

    const status = police?.options?.find(
      (option: { name: string }) => option.name === "status",
    );
    const statusClanOption = status?.options?.find(
      (option: { name: string }) => option.name === "clan",
    );
    expect(statusClanOption?.required).toBe(false);
    expect(statusClanOption?.type).toBe(ApplicationCommandOptionType.String);
    expect(statusClanOption?.autocomplete).toBe(true);

    const setTemplate = police?.options?.find(
      (option: { name: string }) => option.name === "set",
    );
    const setTemplateTextOption = setTemplate?.options?.find(
      (option: { name: string }) => option.name === "template",
    );
    expect(setTemplateTextOption?.required).toBe(true);
    expect(setTemplateTextOption?.type).toBe(
      ApplicationCommandOptionType.String,
    );

    const send = police?.options?.find(
      (option: { name: string }) => option.name === "send",
    );
    const sendShowOption = send?.options?.find(
      (option: { name: string }) => option.name === "show",
    );
    expect(sendShowOption?.required).toBe(true);
    expect(sendShowOption?.type).toBe(ApplicationCommandOptionType.String);
  });
});

