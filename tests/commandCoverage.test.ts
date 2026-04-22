import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Commands } from "../src/Commands";
import {
  buildHelpDetailEmbeds,
  getHelpEmbedCharacterCount,
  getHelpDocumentedCommandNames,
  moveHelpDetailPage,
  setHelpSelectedCommand,
} from "../src/commands/Help";
import { hasPermissionTargetForCommand } from "../src/services/CommandPermissionService";

function docsCommandNames(): Set<string> {
  const commandsDocPath = join(process.cwd(), "docs", "commands.md");
  const text = readFileSync(commandsDocPath, "utf8");
  const names = new Set<string>();
  const regex = /\/([a-z0-9-]+)/gi;
  let match: RegExpExecArray | null = regex.exec(text);
  while (match) {
    const name = String(match[1] ?? "").trim().toLowerCase();
    if (name) names.add(name);
    match = regex.exec(text);
  }
  return names;
}

describe("command coverage", () => {
  it("ensures every registered command has a permissions target", () => {
    const missing = Commands.map((command) => command.name).filter(
      (name) => !hasPermissionTargetForCommand(name)
    );
    expect(missing).toEqual([]);
  });

  it("ensures every registered root command has help docs", () => {
    const documented = new Set(getHelpDocumentedCommandNames());
    const missing = Commands.map((command) => command.name).filter(
      (name) => !documented.has(name)
    );
    expect(missing).toEqual([]);
  });

  it("caps oversized help docs at ten embeds", () => {
    const embeds = buildHelpDetailEmbeds(
      {
        name: "oversized",
        description: "x".repeat(5000),
        options: [],
      },
      {
        summary: "y".repeat(5000),
        details: Array.from({ length: 220 }, (_value, index) =>
          `Detail ${index + 1} ${"d".repeat(260)}`,
        ),
        examples: Array.from({ length: 220 }, (_value, index) =>
          `Example ${index + 1} ${"e".repeat(260)}`,
        ),
      },
    );

    expect(embeds.length).toBeGreaterThan(1);
    expect(embeds).toHaveLength(10);
    expect(embeds.at(-1)?.toJSON().footer?.text?.toLowerCase()).toContain(
      "continued/truncated",
    );
    for (const embed of embeds) {
      const json = embed.toJSON() as any;
      expect(json.description?.length ?? 0).toBeLessThanOrEqual(4096);
      expect(json.fields?.length ?? 0).toBeLessThanOrEqual(25);
      for (const field of json.fields ?? []) {
        expect(field.name.length).toBeLessThanOrEqual(256);
        expect(field.value.length).toBeLessThanOrEqual(1024);
      }
      expect(getHelpEmbedCharacterCount(json)).toBeLessThanOrEqual(4000);
    }
  });

  it("keeps real /fwa help detail pages within the ten-embed limit", () => {
    const fwa = Commands.find((command) => command.name === "fwa");
    expect(fwa).toBeTruthy();

    const embeds = buildHelpDetailEmbeds(fwa!);
    expect(embeds.length).toBeLessThanOrEqual(10);
    expect(embeds[0]?.toJSON().title).toBe("/fwa");

    expect(
      embeds.every(
        (embed) => getHelpEmbedCharacterCount(embed.toJSON() as any) <= 4000,
      ),
    ).toBe(true);
    expect(
      embeds.every((embed) =>
        (embed.toJSON().fields ?? []).every(
          (field: any) => field.name.length <= 256 && field.value.length <= 1024,
        ),
      ),
    ).toBe(true);
    if (embeds.length === 10) {
      expect(embeds.at(-1)?.toJSON().footer?.text?.toLowerCase()).toContain(
        "continued/truncated",
      );
    }
  });

  it("moves and resets help detail navigation state", () => {
    const commands = [Commands.find((command) => command.name === "help")!, Commands.find((command) => command.name === "fwa")!];
    const state = {
      page: 3,
      selectedCommand: "help",
      detailView: true,
      detailPage: 2,
    };

    moveHelpDetailPage(state, -1, 5);
    expect(state.detailPage).toBe(1);

    moveHelpDetailPage(state, 999, 5);
    expect(state.detailPage).toBe(4);

    setHelpSelectedCommand(state, commands, "fwa");
    expect(state.selectedCommand).toBe("fwa");
    expect(state.detailView).toBe(true);
    expect(state.detailPage).toBe(0);
  });

  it("keeps short help pages to one embed", () => {
    const help = Commands.find((command) => command.name === "help");
    expect(help).toBeTruthy();

    const embeds = buildHelpDetailEmbeds(help!);
    expect(embeds).toHaveLength(1);

    const json = embeds[0]?.toJSON() as any;
    expect(json.fields?.map((field: any) => field.name)).toEqual([
      "What It Does",
      "Syntax",
      "Examples",
      "Access",
    ]);
  });

  it("ensures every registered command is documented in docs/commands.md", () => {
    const readmeNames = docsCommandNames();
    const missing = Commands.map((command) => command.name).filter(
      (name) => !readmeNames.has(name)
    );
    expect(missing).toEqual([]);
  });
});
