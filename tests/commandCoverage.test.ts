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

function helpEmbedText(commandName: string): string {
  const command = Commands.find((entry) => entry.name === commandName);
  expect(command).toBeTruthy();
  return buildHelpDetailEmbeds(command!)
    .map((embed) => {
      const json = embed.toJSON() as any;
      return [
        json.title,
        json.description,
        ...(json.fields ?? []).flatMap((field: any) => [field.name, field.value]),
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n");
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

  it("omits the removed standalone /fwa mail send command from FWA help", () => {
    const fwaHelpText = helpEmbedText("fwa");
    expect(fwaHelpText).not.toContain("/fwa mail send");
    expect(fwaHelpText).not.toContain("command:fwa:mail:send");
  });

  it("documents the standalone /fwa match-checklist command in FWA help detail text", () => {
    const fwaHelpText = helpEmbedText("fwa");
    const normalized = fwaHelpText.toLowerCase();
    expect(fwaHelpText).toContain("/fwa match-checklist");
    expect(fwaHelpText).not.toContain("checklist:true");
    expect(normalized).toContain("default is `type:mail`");
    expect(normalized).toContain("public mail checklist posts are auto-pinned");
    expect(normalized).toContain("persistent reaction-driven mail checklist");
    expect(normalized).toContain("type:bases");
    expect(normalized).toContain("reaction-driven bases checklist");
    expect(normalized).toContain("with `refresh`");
    expect(normalized).toContain("private is snapshot-only");
    expect(normalized).toContain("clan:<tag-or-short-name> checked:true|false");
    expect(normalized).toContain("bases reminders go to the clan's configured leader/notify/log channel at 12h, 6h, 3h, and 1h left");
    expect(normalized).toContain("clan:<tag-or-short-name>");
    expect(normalized).toContain("checked:true|false");
    expect(normalized).toContain("can be refreshed to rebuild the current match state");
    expect(normalized).toContain("auto-post to `/bot-logs type:checklist channel:<channel>`");
    expect(normalized).toContain("snapshot-only");
  });

  it("documents roster manage change group and change roster wording in roster help detail text", () => {
    const rosterHelpText = helpEmbedText("roster");
    const normalized = rosterHelpText.toLowerCase();
    expect(normalized).toContain("change group");
    expect(normalized).toContain("change roster");
    expect(normalized).toContain("target_group");
    expect(normalized).toContain("another roster");
  });

  it("documents the blacklist import command in FWA help detail text", () => {
    const fwaHelpText = helpEmbedText("fwa");
    const normalized = fwaHelpText.toLowerCase();
    expect(fwaHelpText).toContain("/fwa blacklist-import");
    expect(normalized).toContain("bulk-registers known blacklist clans");
    expect(normalized).toContain("admin-only by default");
  });

  it("documents the blacklist sample rebuild command in FWA help detail text", () => {
    const fwaHelpText = helpEmbedText("fwa");
    const normalized = fwaHelpText.toLowerCase();
    expect(fwaHelpText).toContain("/fwa blacklist-samples rebuild");
    expect(normalized).toContain("persisted blacklist matchup samples");
    expect(normalized).toContain("admin-only by default");
  });

  it("documents the blacklist profile rebuild command in FWA help detail text", () => {
    const fwaHelpText = helpEmbedText("fwa");
    const normalized = fwaHelpText.toLowerCase();
    expect(fwaHelpText).toContain("/fwa blacklist-profile rebuild");
    expect(normalized).toContain("blacklist heatmapref profile");
    expect(normalized).toContain("admin-only by default");
  });

  it("documents base-swap log routing in FWA help detail text", () => {
    const fwaHelpText = helpEmbedText("fwa");
    const normalized = fwaHelpText.toLowerCase();
    expect(fwaHelpText).toContain("/fwa base-swap");
    expect(normalized).not.toContain("log-enable");
    expect(normalized).toContain("/bot-logs type:base-swap enable:");
    expect(normalized).toContain("bot-log channel");
    expect(normalized).toContain("custom");
  });

  it("documents maintenance bot-log routing in the bot-logs help detail text", () => {
    const botLogsHelpText = helpEmbedText("bot-logs");
    const normalized = botLogsHelpText.toLowerCase();
    expect(botLogsHelpText).not.toContain("set-channel");
    expect(normalized).toContain("/bot-logs channel:<channel>");
    expect(botLogsHelpText).toContain("type:maintenance");
    expect(normalized).toContain("maintenance start/end notices");
    expect(botLogsHelpText).toContain("type:sync");
    expect(normalized).toContain("scheduled sync spin status");
    expect(botLogsHelpText).toContain("type:checklist");
    expect(normalized).toContain("auto-posted `/fwa match-checklist type:mail`");
    expect(normalized).toContain("type:base-swap");
    expect(normalized).toContain("enable:<clan-log channel|clan-lead channel|bot-log channel|custom|false>");
    expect(normalized).toContain("enable:false");
  });

  it("documents the /clan root in clan help detail text", () => {
    const clanHelpText = helpEmbedText("clan");
    expect(clanHelpText).toContain("/clan configure");
    expect(clanHelpText).toContain("leader channel");
    expect(clanHelpText).toContain("lead-role");
    expect(clanHelpText).toContain("display:minimal|detailed");
    expect(clanHelpText.toLowerCase()).toContain("default `minimal`");
    expect(clanHelpText.toLowerCase()).toContain("if `type` is omitted, `display` is ignored");
    expect(clanHelpText).toContain("member-count `Refresh` button");
    expect(clanHelpText).not.toContain("/tracked-clan configure");
  });

  it("documents clan-lead routing in unlinked help detail text", () => {
    const unlinkedHelpText = helpEmbedText("unlinked");
    expect(unlinkedHelpText).toContain("clan-lead channel");
    expect(unlinkedHelpText).toContain("leader-channel");
  });

  it("documents /raids overview source modes in the raids help detail text", () => {
    const raidsHelpText = helpEmbedText("raids");
    expect(raidsHelpText).toContain("type:raids");
    expect(raidsHelpText).toContain("type:fwa");
    expect(raidsHelpText).toContain("type:custom");
    expect(raidsHelpText).not.toContain("type:custom tag:");
    expect(raidsHelpText).toContain("Medal estimates");
    expect(raidsHelpText).toContain("cleared districts/capital peaks");
    expect(raidsHelpText).toContain("defensiveReward");
    expect(raidsHelpText).toContain("Total appears only when both values are available");
    expect(raidsHelpText).toContain("/raids roster add");
    expect(raidsHelpText).toContain("/raids roster status");
    expect(raidsHelpText).toContain("already on roster");
  });

  it("registers /compo fill as a subcommand", () => {
    const compo = Commands.find((command) => command.name === "compo");
    expect(compo).toBeTruthy();
    expect(
      (compo?.options ?? []).some((option) => option.name === "fill"),
    ).toBe(true);
  });

  it("documents /compo fill in the compo help detail text", () => {
    const compoHelpText = helpEmbedText("compo");
    expect(compoHelpText).toContain("/compo fill");
    expect(compoHelpText).toContain("remaining open slots");
  });

  it("documents the /link list Columns dropdown in the link help detail text", () => {
    const linkHelpText = helpEmbedText("link");
    expect(linkHelpText).toContain("reads persisted current-member rows by default");
    expect(linkHelpText).toContain("Columns dropdown");
    expect(linkHelpText).toContain("choose 1-5 visible fields");
    expect(linkHelpText).toContain("Refresh Data");
    expect(linkHelpText).toContain("Town Hall as a bare number or `?` label inside inline code");
    expect(linkHelpText).toContain("keep the player name visible");
    expect(linkHelpText).toContain("selected columns are preserved across Refresh Data, sort cycling, and tracked-clan switching");
    expect(linkHelpText).toContain("only mode that shows the player tag");
    expect(linkHelpText).toContain("`Player Tag` stays in its own inline-code cell");
    expect(linkHelpText).toContain("while filler rows can show a trailing");
    expect(linkHelpText).toContain("marker outside inline code");
    expect(linkHelpText).toContain("Sort controls row order while columns control visible fields");
    expect(linkHelpText).toContain("Available columns are Town Hall, Player Name, Discord Display, Discord Username, Weight, Inactivity, Clan Role, and Player Tag");
    expect(linkHelpText).toContain("Discord Name -> Weight Desc -> Player Tags -> Player Name -> Clan Role -> Inactivity");
    expect(linkHelpText).toContain("Clan Role");
    expect(linkHelpText).toContain("Inactivity");
    expect(linkHelpText).toContain("same missed-war data as `/inactive wars`");
    expect(linkHelpText).toContain("unless a reliable shared days source is available");
    expect(linkHelpText).toContain("/link list clan-tag:2QG2C08UP");
  });

  it("documents consecutive filtering in the /inactive help detail text", () => {
    const inactiveHelpText = helpEmbedText("inactive");
    expect(inactiveHelpText).toContain("in-clan:false");
    expect(inactiveHelpText).toContain("/inactive days:7 consecutive:true");
    expect(inactiveHelpText).toContain("/inactive wars:3 consecutive:true");
    expect(inactiveHelpText).toContain("toggles between player tags and compact weights");
  });

  it("documents recruitment countdown reminder settings in the recruitment help detail text", () => {
    const recruitmentHelpText = helpEmbedText("recruitment");
    const normalized = recruitmentHelpText.toLowerCase();
    expect(recruitmentHelpText).toContain("/recruitment countdown settings reminders:false");
    expect(normalized).toContain("reminders:true|false");
    expect(normalized).toContain("muted timers still appear");
  });

  it("documents /compo heatmapref blacklist mode in the compo help detail text", () => {
    const compoHelpText = helpEmbedText("compo");
    expect(compoHelpText).toContain("/compo heatmapref mode:blacklist");
    expect(compoHelpText).toContain("blacklist profile rows");
    expect(compoHelpText).toContain("/fwa blacklist-profile rebuild");
  });

  it("documents /autorole refresh in the autorole help detail text", () => {
    const autoroleHelpText = helpEmbedText("autorole");
    expect(autoroleHelpText).toContain("/autorole refresh");
    expect(autoroleHelpText).toContain("manual refresh");
    expect(autoroleHelpText).toContain("non-member-role");
    expect(autoroleHelpText).toContain("non-member-enabled");
    expect(autoroleHelpText).toContain("visitor/non-member role");
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
