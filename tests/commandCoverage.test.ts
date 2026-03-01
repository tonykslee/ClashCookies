import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Commands } from "../src/Commands";
import { getHelpDocumentedCommandNames } from "../src/commands/Help";
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

  it("ensures every registered command has help docs", () => {
    const documented = new Set(getHelpDocumentedCommandNames());
    const missing = Commands.map((command) => command.name).filter(
      (name) => !documented.has(name)
    );
    expect(missing).toEqual([]);
  });

  it("ensures every registered command is documented in docs/commands.md", () => {
    const readmeNames = docsCommandNames();
    const missing = Commands.map((command) => command.name).filter(
      (name) => !readmeNames.has(name)
    );
    expect(missing).toEqual([]);
  });
});
