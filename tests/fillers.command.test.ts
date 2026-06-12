import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildHelpDetailEmbeds,
  getHelpDocumentedCommandNames,
} from "../src/commands/Help";
import { Fillers } from "../src/commands/Fillers";
import {
  FWA_LEADER_ROLE_SETTING_KEY,
  CommandPermissionService,
} from "../src/services/CommandPermissionService";

const prismaMock = vi.hoisted(() => ({
  fillerAccount: {
    findMany: vi.fn(),
    upsert: vi.fn(),
    deleteMany: vi.fn(),
  },
  playerLink: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    updateMany: vi.fn(),
  },
  playerActivity: {
    findMany: vi.fn(),
  },
  trackedClan: {
    findMany: vi.fn(),
  },
  fwaClanMemberCurrent: {
    findMany: vi.fn(),
  },
  fwaPlayerCatalog: {
    findMany: vi.fn(),
  },
  externalPlayerWeightCurrent: {
    findMany: vi.fn(),
  },
}));

const playerCurrentServiceMock = vi.hoisted(() => ({
  listPlayerCurrentByTags: vi.fn(),
}));

const deferredWeightServiceMock = vi.hoisted(() => ({
  listOpenDeferredWeightsByClanAndPlayerTags: vi.fn(),
}));

const emojiResolverMock = vi.hoisted(() => ({
  fetchApplicationEmojiInventory: vi.fn(),
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

vi.mock("../src/services/PlayerCurrentService", () => ({
  playerCurrentService: playerCurrentServiceMock,
}));

vi.mock("../src/services/WeightInputDefermentService", () => ({
  listOpenDeferredWeightsByClanAndPlayerTags:
    deferredWeightServiceMock.listOpenDeferredWeightsByClanAndPlayerTags,
}));

vi.mock("../src/services/emoji/EmojiResolverService", async () => {
  const actual = await vi.importActual<
    typeof import("../src/services/emoji/EmojiResolverService")
  >("../src/services/emoji/EmojiResolverService");
  return {
    ...actual,
    emojiResolverService: {
      ...actual.emojiResolverService,
      fetchApplicationEmojiInventory: emojiResolverMock.fetchApplicationEmojiInventory,
    },
  };
});

type PlayerLinkRow = {
  playerTag: string;
  discordUserId: string | null;
  discordUsername: string | null;
  playerName: string | null;
  linkSource: string;
  verificationStatus: string;
  verificationMethod: string | null;
  verifiedAt: Date | null;
  verifiedByDiscordUserId: string | null;
  lastVerifiedAt: Date | null;
  verificationFailureReason: string | null;
  importBatchKey: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type PlayerCurrentRow = {
  playerTag: string;
  playerName: string;
  townHall: number;
  currentClanTag: string | null;
  currentClanName: string | null;
  role: string | null;
  currentWeight: number | null;
};

const fillerState = new Set<string>();
const playerLinkFixtures = new Map<string, PlayerLinkRow>();
const playerCurrentFixtures = new Map<string, PlayerCurrentRow>();

function makeValidPlayerTag(index: number): string {
  const alphabet = ["0", "2", "8", "9"];
  const digits = [0, 0, 0, 0];
  let remaining = Math.max(0, Math.trunc(index));
  for (let pos = digits.length - 1; pos >= 0; pos -= 1) {
    digits[pos] = remaining % alphabet.length;
    remaining = Math.trunc(remaining / alphabet.length);
  }
  return `#P${digits.map((digit) => alphabet[digit] ?? "0").join("")}`;
}

function makePlayerLinkRow(input: {
  playerTag: string;
  discordUserId: string;
  playerName: string;
  createdAt?: Date;
}): PlayerLinkRow {
  const createdAt = input.createdAt ?? new Date("2026-03-01T00:00:00.000Z");
  return {
    playerTag: input.playerTag,
    discordUserId: input.discordUserId,
    discordUsername: `User ${input.discordUserId}`,
    playerName: input.playerName,
    linkSource: "ADMIN_CREATE",
    verificationStatus: "VERIFIED",
    verificationMethod: "ADMIN_OVERRIDE",
    verifiedAt: createdAt,
    verifiedByDiscordUserId: null,
    lastVerifiedAt: createdAt,
    verificationFailureReason: null,
    importBatchKey: null,
    createdAt,
    updatedAt: createdAt,
  };
}

function makePlayerCurrentRow(input: {
  playerTag: string;
  playerName: string;
  townHall: number;
  clanTag: string | null;
  clanName: string | null;
  role?: string | null;
  weight?: number | null;
}): PlayerCurrentRow {
  return {
    playerTag: input.playerTag,
    playerName: input.playerName,
    townHall: input.townHall,
    currentClanTag: input.clanTag,
    currentClanName: input.clanName,
    role: input.role ?? "member",
    currentWeight: input.weight ?? null,
  };
}

function seedAccount(input: {
  playerTag: string;
  discordUserId: string;
  playerName: string;
  townHall: number;
  clanTag: string | null;
  clanName: string | null;
  weight?: number | null;
  role?: string | null;
  createdAt?: Date;
}): void {
  playerLinkFixtures.set(
    input.playerTag,
    makePlayerLinkRow({
      playerTag: input.playerTag,
      discordUserId: input.discordUserId,
      playerName: input.playerName,
      createdAt: input.createdAt,
    }),
  );
  playerCurrentFixtures.set(
    input.playerTag,
    makePlayerCurrentRow({
      playerTag: input.playerTag,
      playerName: input.playerName,
      townHall: input.townHall,
      clanTag: input.clanTag,
      clanName: input.clanName,
      role: input.role ?? "member",
      weight: input.weight ?? null,
    }),
  );
}

function buildEmojiInventory(renderedPrefix = "<:th"): any {
  const exactByName = new Map<string, { rendered: string }>();
  const lowercaseByName = new Map<string, { rendered: string }>();
  for (let townHall = 1; townHall <= 18; townHall += 1) {
    const rendered = `${renderedPrefix}${townHall}:12345678901234567>`;
    const entry = { rendered };
    exactByName.set(`th${townHall}`, entry);
    lowercaseByName.set(`th${townHall}`, entry);
  }
  return {
    ok: true,
    snapshot: {
      exactByName,
      lowercaseByName,
      entries: [],
    },
    diagnostics: {
      emojiFetchSucceeded: true,
    },
  };
}

function setMockImplementations(): void {
  prismaMock.playerLink.findMany.mockImplementation(async (query: any) => {
    const where = query?.where ?? {};
    let rows = [...playerLinkFixtures.values()];
    if (where.discordUserId) {
      rows = rows.filter((row) => row.discordUserId === where.discordUserId);
    }
    if (where.playerTag?.in) {
      const tags = new Set<string>(where.playerTag.in);
      rows = rows.filter((row) => tags.has(row.playerTag));
    }
    return rows;
  });
  prismaMock.playerLink.findUnique.mockResolvedValue(null);
  prismaMock.playerLink.updateMany.mockResolvedValue({ count: 0 });

  prismaMock.fillerAccount.findMany.mockImplementation(async (query: any) => {
    const where = query?.where ?? {};
    let tags = [...fillerState];
    if (where.playerTag?.in) {
      const allowed = new Set<string>(where.playerTag.in);
      tags = tags.filter((tag) => allowed.has(tag));
    }
    return tags.map((playerTag) => ({ playerTag }));
  });
  prismaMock.fillerAccount.upsert.mockImplementation(async (input: any) => {
    const playerTag = String(input?.create?.playerTag ?? input?.where?.guildId_playerTag?.playerTag ?? "").trim();
    if (playerTag) {
      fillerState.add(playerTag);
    }
    return {
      id: `filler-${playerTag}`,
      guildId: String(input?.create?.guildId ?? input?.where?.guildId_playerTag?.guildId ?? "guild-1"),
      playerTag,
      createdByDiscordUserId: String(input?.create?.createdByDiscordUserId ?? ""),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  });
  prismaMock.fillerAccount.deleteMany.mockImplementation(async (input: any) => {
    const tags = new Set<string>(input?.where?.playerTag?.in ?? []);
    let count = 0;
    for (const tag of tags) {
      if (fillerState.delete(tag)) {
        count += 1;
      }
    }
    return { count };
  });

  prismaMock.playerActivity.findMany.mockResolvedValue([]);
  prismaMock.trackedClan.findMany.mockResolvedValue([]);
  prismaMock.fwaClanMemberCurrent.findMany.mockResolvedValue([]);
  prismaMock.fwaPlayerCatalog.findMany.mockResolvedValue([]);
  prismaMock.externalPlayerWeightCurrent.findMany.mockResolvedValue([]);

  playerCurrentServiceMock.listPlayerCurrentByTags.mockImplementation(async (tags: string[]) => {
    return new Map(tags.map((tag) => [tag, playerCurrentFixtures.get(tag) ?? null]));
  });
  deferredWeightServiceMock.listOpenDeferredWeightsByClanAndPlayerTags.mockResolvedValue(new Map());
  emojiResolverMock.fetchApplicationEmojiInventory.mockResolvedValue({
    ok: false,
  });
}

function makeInteraction(input: {
  subcommand: "list" | "set";
  userId?: string;
  targetUserId?: string;
  clan?: string | null;
}) {
  const collectorHandlers: Record<string, any> = {};
  const collector = {
    on: vi.fn((event: string, handler: any) => {
      collectorHandlers[event] = handler;
      return collector;
    }),
  };
  const message = {
    id: `message-${Math.random().toString(36).slice(2)}`,
    edit: vi.fn().mockResolvedValue(undefined),
    createMessageComponentCollector: vi.fn(() => collector),
  };

  return {
    guildId: "guild-1",
    id: `interaction-${Math.random().toString(36).slice(2)}`,
    user: { id: input.userId ?? "111111111111111111" },
    inGuild: () => true,
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(message),
    fetchReply: vi.fn().mockResolvedValue(message),
    options: {
      getSubcommand: vi.fn(() => input.subcommand),
      getUser: vi.fn((name: string) => {
        if (name === "user" && input.targetUserId) {
          return { id: input.targetUserId };
        }
        return null;
      }),
      getString: vi.fn((name: string) => {
        if (name === "clan") return input.clan ?? null;
        return null;
      }),
    },
    __collectorHandlers: collectorHandlers,
    __message: message,
  };
}

function makeSelectInteraction(input: {
  customId: string;
  values: string[];
}) {
  return {
    customId: input.customId,
    user: { id: "111111111111111111" },
    values: input.values,
    isButton: () => false,
    update: vi.fn().mockResolvedValue(undefined),
    deferUpdate: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    replied: false,
    deferred: false,
    reply: vi.fn().mockResolvedValue(undefined),
  };
}

function makeButtonInteraction(input: {
  customId: string;
}) {
  return {
    customId: input.customId,
    user: { id: "111111111111111111" },
    isButton: () => true,
    update: vi.fn().mockResolvedValue(undefined),
    deferUpdate: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    replied: false,
    deferred: false,
    reply: vi.fn().mockResolvedValue(undefined),
  };
}

function getLastEditPayload(interaction: any): any {
  return interaction.editReply.mock.calls.at(-1)?.[0] ?? {};
}

function getLastInteractionUpdatePayload(interaction: any): any {
  return interaction.update.mock.calls.at(-1)?.[0] ?? {};
}

function getLastInteractionEditReplyPayload(interaction: any): any {
  return interaction.editReply.mock.calls.at(-1)?.[0] ?? {};
}

function getEmbedJson(payload: any): any {
  const embed = payload?.embeds?.[0];
  return embed?.toJSON?.() ?? embed ?? {};
}

function getComponentJson(payload: any): any[] {
  return (payload?.components ?? []).map((component: any) => component.toJSON?.() ?? component);
}

function extractVisibleTags(description: string): string[] {
  return String(description)
    .split("\n")
    .map((line) => {
      const match = line.match(/`(#[^`]+)`/);
      return match?.[1] ?? null;
    })
    .filter((tag): tag is string => Boolean(tag));
}

function collectDropdownValues(components: any[]): string[] {
  return components.flatMap((row) =>
    (row.components ?? []).flatMap((component: any) =>
      Array.isArray(component.options) ? component.options.map((option: any) => String(option.value ?? "")) : [],
    ),
  );
}

async function runFillers(interaction: any): Promise<void> {
  await Fillers.run({} as any, interaction as any);
}

beforeEach(() => {
  vi.clearAllMocks();
  fillerState.clear();
  playerLinkFixtures.clear();
  playerCurrentFixtures.clear();
  setMockImplementations();
});

describe("/fillers command", () => {
  it("documents the new fillers command in help", () => {
    expect(getHelpDocumentedCommandNames()).toContain("fillers");
    const helpText = buildHelpDetailEmbeds(Fillers)
      .map((embed) => {
        const json = embed.toJSON() as any;
        return [json.title, json.description, ...(json.fields ?? []).flatMap((field: any) => [field.name, field.value])]
          .filter(Boolean)
          .join("\n");
      })
      .join("\n");

    expect(helpText).toContain("/fillers list");
    expect(helpText).toContain("/fillers set");
  });

  it("shows a clear empty state when the target user has no linked accounts", async () => {
    const interaction = makeInteraction({
      subcommand: "set",
      targetUserId: "222222222222222222",
    });

    await runFillers(interaction);

    expect(interaction.editReply).toHaveBeenCalledWith({
      content: "No linked accounts were found for <@222222222222222222>.",
    });
  });

  it("logs normal /fillers set diagnostics at debug level instead of error", async () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    seedAccount({
      playerTag: makeValidPlayerTag(0),
      discordUserId: "222222222222222222",
      playerName: "Player 001",
      townHall: 18,
      clanTag: "#PQL0289",
      clanName: "Alpha Clan",
      weight: 9000,
    });

    const interaction = makeInteraction({
      subcommand: "set",
      targetUserId: "222222222222222222",
    });

    await runFillers(interaction);

    expect(errorSpy).not.toHaveBeenCalled();
    expect(debugSpy).toHaveBeenCalled();
  });

  it("still logs real /fillers set failures at error level", async () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    prismaMock.playerLink.findMany.mockRejectedValueOnce(new Error("boom"));

    const interaction = makeInteraction({
      subcommand: "set",
      targetUserId: "222222222222222222",
    });

    await runFillers(interaction);

    expect(errorSpy).toHaveBeenCalled();
    expect(debugSpy).not.toHaveBeenCalledWith(expect.stringContaining("stage=fillers_set_fetch_rows"));
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: expect.stringContaining("Could not render the filler editor"),
    });
  });

  it("keeps the select collector active for a single-page editor and persists filler state", async () => {
    for (let index = 0; index < 2; index += 1) {
      const tag = makeValidPlayerTag(index);
      seedAccount({
        playerTag: tag,
        discordUserId: "222222222222222222",
        playerName: `Player ${String(index + 1).padStart(3, "0")}`,
        townHall: index === 0 ? 18 : 17,
        clanTag: "#PQL0289",
        clanName: "Alpha Clan",
        weight: index === 0 ? 9200 : 8400,
      });
    }

    const interaction = makeInteraction({
      subcommand: "set",
      targetUserId: "222222222222222222",
    });

    await runFillers(interaction);

    const payload = getLastEditPayload(interaction);
    const components = getComponentJson(payload);
    expect(components).toHaveLength(1);
    expect(interaction.__collectorHandlers.collect).toEqual(expect.any(Function));

    const firstMenu = components[0].components[0];
    const select = makeSelectInteraction({
      customId: firstMenu.custom_id ?? firstMenu.customId,
      values: [makeValidPlayerTag(0)],
    });

    await interaction.__collectorHandlers.collect(select);

    expect(prismaMock.fillerAccount.upsert).toHaveBeenCalledTimes(1);
    expect(fillerState.has(makeValidPlayerTag(0))).toBe(true);
    expect(select.deferUpdate).toHaveBeenCalledTimes(1);
    expect(select.deferUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      select.editReply.mock.invocationCallOrder[0],
    );
    expect(select.editReply).toHaveBeenCalledTimes(1);

    const rerenderPayload = getLastInteractionEditReplyPayload(select);
    const rerenderComponents = getComponentJson(rerenderPayload);
    const rerenderMenu = rerenderComponents[0].components[0];
    expect(rerenderMenu.options[0].default).toBe(true);
  });

  it("suppresses stale collector interactions without crashing the process", async () => {
    for (let index = 0; index < 2; index += 1) {
      seedAccount({
        playerTag: makeValidPlayerTag(index),
        discordUserId: "222222222222222222",
        playerName: `Player ${String(index + 1).padStart(3, "0")}`,
        townHall: 18,
        clanTag: "#PQL0289",
        clanName: "Alpha Clan",
        weight: index === 0 ? 9200 : 8400,
      });
    }

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const interaction = makeInteraction({
      subcommand: "set",
      targetUserId: "222222222222222222",
    });

    await runFillers(interaction);

    const payload = getLastEditPayload(interaction);
    const firstMenu = getComponentJson(payload)[0].components[0];
    const select = makeSelectInteraction({
      customId: firstMenu.custom_id ?? firstMenu.customId,
      values: [makeValidPlayerTag(0)],
    });
    select.deferUpdate.mockRejectedValueOnce(Object.assign(new Error("Unknown interaction"), { code: 10062 }));

    await expect(interaction.__collectorHandlers.collect(select)).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("fillers editor collector ignored interaction error"),
    );
    expect(prismaMock.fillerAccount.upsert).not.toHaveBeenCalled();
  });

  it("renders a sorted, paginated editor with filler markers and dropdown groups", async () => {
    for (let index = 0; index < 126; index += 1) {
      const tag = makeValidPlayerTag(index);
      const townHall = index === 0 ? 18 : index === 1 ? 17 : index === 2 ? 17 : index % 3 === 0 ? 16 : 15;
      const weight = index === 0 ? 9000 : index === 1 ? 8500 : index === 2 ? 8200 : 4000 + (125 - index);
      seedAccount({
        playerTag: tag,
        discordUserId: "222222222222222222",
        playerName: `Player ${String(index + 1).padStart(3, "0")}`,
        townHall,
        clanTag: "#PQL0289",
        clanName: "Alpha Clan",
        weight,
      });
    }
    fillerState.clear();

    const interaction = makeInteraction({
      subcommand: "set",
      targetUserId: "222222222222222222",
    });

    await runFillers(interaction);

    const payload = getLastEditPayload(interaction);
    const embed = getEmbedJson(payload);
    const components = getComponentJson(payload);
    const visibleTags = extractVisibleTags(String(embed.description));
    const dropdownValues = collectDropdownValues(components);

    expect(String(embed.title)).toBe("Filler Accounts (126)");
    expect(String(embed.footer?.text)).toContain("0/126 filler accounts selected");
    expect(String(embed.footer?.text)).toContain("Page 1/");
    expect(components).toHaveLength(3);
    expect(components[0].components).toHaveLength(1);
    expect(components[1].components).toHaveLength(1);
    expect(components[2].components).toHaveLength(2);

    const firstMenu = components[0].components[0];
    expect(firstMenu.options).toHaveLength(Math.min(25, visibleTags.length));
    expect(dropdownValues).toEqual(visibleTags);
    expect(String(firstMenu.options[0].label)).toBe("9k Player 001");
    expect(String(firstMenu.options[0].label)).not.toContain("<:");
    expect(firstMenu.options[0].value).toBe(makeValidPlayerTag(0));
    expect(firstMenu.options[1].value).toBe(makeValidPlayerTag(1));
    expect(firstMenu.options[2].value).toBe(makeValidPlayerTag(2));
    expect(firstMenu.options[0].default).toBe(false);
    expect(String(embed.description)).not.toContain("No linked accounts found.");
  });

  it("keeps the editor description under Discord limits for long 59-account pages", async () => {
    emojiResolverMock.fetchApplicationEmojiInventory.mockResolvedValueOnce(
      buildEmojiInventory("<:town_hall_custom_"),
    );

    const seededOrder: string[] = [];
    for (let index = 0; index < 59; index += 1) {
      const tag = makeValidPlayerTag(index);
      seededOrder.push(tag);
      const clanName = `The Extremely Long And Verbose Clan Name For Production Diagnostics ${String(index + 1).padStart(2, "0")} [FWA]`;
      seedAccount({
        playerTag: tag,
        discordUserId: "222222222222222222",
        playerName: `Teewizz Candidate ${String(index + 1).padStart(2, "0")} With An Exceptionally Long Display Name For Markdown Rendering`,
        townHall: 18,
        clanTag: "#PQL0289",
        clanName,
        weight: 12000 - index * 17,
      });
    }

    const interaction = makeInteraction({
      subcommand: "set",
      targetUserId: "222222222222222222",
    });

    await runFillers(interaction);

    const payload = getLastEditPayload(interaction);
    const embed = getEmbedJson(payload);
    const components = getComponentJson(payload);
    const visibleTags = extractVisibleTags(String(embed.description));
    const dropdownValues = collectDropdownValues(components);

    expect(String(embed.description).length).toBeLessThanOrEqual(4096);
    expect(visibleTags.length).toBeLessThan(25);
    expect(dropdownValues).toEqual(visibleTags);
    expect(visibleTags).toEqual(seededOrder.slice(0, visibleTags.length));
    expect(String(embed.description)).not.toContain("more account(s) on this page are not shown in the preview");
    expect(String(embed.description)).not.toContain("remain selectable in the dropdown below");

    const pagerRow = components.at(-1);
    const nextButton = pagerRow?.components?.find((component: any) => String(component.custom_id ?? component.customId ?? "").endsWith(":next"));
    expect(nextButton).toBeTruthy();
    const nextInteraction = makeButtonInteraction({
      customId: nextButton.custom_id ?? nextButton.customId,
    });
    await interaction.__collectorHandlers.collect(nextInteraction);

    expect(nextInteraction.update).toHaveBeenCalledTimes(1);
    expect(nextInteraction.deferUpdate).not.toHaveBeenCalled();

    const nextPayload = getLastInteractionUpdatePayload(nextInteraction);
    const nextEmbed = getEmbedJson(nextPayload);
    const nextVisibleTags = extractVisibleTags(String(nextEmbed.description));
    expect(nextVisibleTags[0]).toBe(seededOrder[visibleTags.length]);
  });

  it("logs the page update failure with navigation context when component.update rejects", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    emojiResolverMock.fetchApplicationEmojiInventory.mockResolvedValueOnce(
      buildEmojiInventory("<:town_hall_custom_"),
    );

    for (let index = 0; index < 59; index += 1) {
      const tag = makeValidPlayerTag(index);
      seedAccount({
        playerTag: tag,
        discordUserId: "222222222222222222",
        playerName: `Player ${String(index + 1).padStart(3, "0")}`,
        townHall: 18,
        clanTag: "#PQL0289",
        clanName: "Alpha Clan",
        weight: 12000 - index * 17,
      });
    }

    const interaction = makeInteraction({
      subcommand: "set",
      targetUserId: "222222222222222222",
    });

    await runFillers(interaction);

    const payload = getLastEditPayload(interaction);
    const pagerRow = getComponentJson(payload).at(-1);
    const nextButton = pagerRow?.components?.find((component: any) =>
      String(component.custom_id ?? component.customId ?? "").endsWith(":next"),
    );
    expect(nextButton).toBeTruthy();

    const nextInteraction = makeButtonInteraction({
      customId: nextButton.custom_id ?? nextButton.customId,
    });
    nextInteraction.update.mockRejectedValueOnce(
      Object.assign(new Error("Unknown Message"), { code: 10008, status: 404 }),
    );

    await interaction.__collectorHandlers.collect(nextInteraction);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('"stage": "fillers_set_editor_component_update_failed"'),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('"operation": "editor_button_next"'),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('"discordErrorCode": 10008'),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('"componentCustomId":'),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('"messageId":'),
    );
  });

  it("keeps clan sections together when they fit on the same editor page", async () => {
    for (let index = 0; index < 8; index += 1) {
      seedAccount({
        playerTag: makeValidPlayerTag(index),
        discordUserId: "222222222222222222",
        playerName: `Alpha ${String(index + 1).padStart(2, "0")}`,
        townHall: 18,
        clanTag: "#PQL0289",
        clanName: "Alpha Clan",
        weight: 12000 - index,
      });
    }
    for (let index = 8; index < 17; index += 1) {
      seedAccount({
        playerTag: makeValidPlayerTag(index),
        discordUserId: "222222222222222222",
        playerName: `Beta ${String(index + 1).padStart(2, "0")}`,
        townHall: 18,
        clanTag: "#QGRJ2222",
        clanName: "Beta Clan",
        weight: 12000 - index,
      });
    }

    const interaction = makeInteraction({
      subcommand: "set",
      targetUserId: "222222222222222222",
    });

    await runFillers(interaction);

    const payload = getLastEditPayload(interaction);
    const embed = getEmbedJson(payload);
    const components = getComponentJson(payload);
    const visibleTags = extractVisibleTags(String(embed.description));
    const dropdownValues = collectDropdownValues(components);

    expect(String(embed.description)).toContain("Alpha Clan");
    expect(String(embed.description)).toContain("Beta Clan");
    expect(String(embed.description).match(/Alpha Clan/g) ?? []).toHaveLength(1);
    expect(String(embed.description).match(/Beta Clan/g) ?? []).toHaveLength(1);
    expect(dropdownValues).toEqual(visibleTags);
    expect(dropdownValues).toHaveLength(17);
  });

  it("creates, updates, and removes filler state through the select interaction", async () => {
    for (let index = 0; index < 26; index += 1) {
      const tag = makeValidPlayerTag(index);
      seedAccount({
        playerTag: tag,
        discordUserId: "222222222222222222",
        playerName: `Player ${String(index + 1).padStart(3, "0")}`,
        townHall: index === 0 ? 18 : index === 1 ? 17 : 16,
        clanTag: "#PQL0289",
        clanName: "Alpha Clan",
        weight: index === 0 ? 9200 : index === 1 ? 8400 : 7300 - index,
      });
    }

    const interaction = makeInteraction({
      subcommand: "set",
      targetUserId: "222222222222222222",
    });

    await runFillers(interaction);
    const firstPayload = getLastEditPayload(interaction);
    const firstMenu = getComponentJson(firstPayload)[0].components[0];
    const collectorHandlers = interaction.__collectorHandlers;
    const selectCustomId = firstMenu.custom_id ?? firstMenu.customId;

    const selectAlpha = makeSelectInteraction({
      customId: selectCustomId,
      values: [makeValidPlayerTag(0)],
    });
    await collectorHandlers.collect(selectAlpha);

    expect(prismaMock.fillerAccount.upsert).toHaveBeenCalledTimes(1);
    expect(fillerState.has(makeValidPlayerTag(0))).toBe(true);
    expect(fillerState.has(makeValidPlayerTag(1))).toBe(false);
    const selectAlphaPayload = getLastInteractionEditReplyPayload(selectAlpha);
    const selectAlphaEmbed = getEmbedJson(selectAlphaPayload);
    expect(String(selectAlphaEmbed.description)).toContain("Alpha");
    expect(String(selectAlphaEmbed.footer?.text)).toContain("1/26 filler accounts selected");

    const selectBeta = makeSelectInteraction({
      customId: selectCustomId,
      values: [makeValidPlayerTag(1)],
    });
    await collectorHandlers.collect(selectBeta);

    expect(prismaMock.fillerAccount.upsert).toHaveBeenCalledTimes(2);
    expect(prismaMock.fillerAccount.deleteMany).toHaveBeenCalledTimes(1);
    expect(fillerState.has(makeValidPlayerTag(0))).toBe(false);
    expect(fillerState.has(makeValidPlayerTag(1))).toBe(true);

    const clearSelection = makeSelectInteraction({
      customId: selectCustomId,
      values: [],
    });
    await collectorHandlers.collect(clearSelection);

    expect(prismaMock.fillerAccount.deleteMany).toHaveBeenCalledTimes(2);
    expect(fillerState.size).toBe(0);
  });

  it("preserves repeated set selections across later sessions and updates clan lists immediately", async () => {
    const clanTag = "#PQL0289";
    const clanName = "Alpha Clan";
    const playerNameByTag = new Map<string, string>();

    for (let index = 0; index < 59; index += 1) {
      const tag = makeValidPlayerTag(index);
      const playerName = `Teewizz Candidate ${String(index + 1).padStart(2, "0")} With An Exceptionally Long Display Name For Markdown Rendering`;
      playerNameByTag.set(tag, playerName);
      seedAccount({
        playerTag: tag,
        discordUserId: "222222222222222222",
        playerName,
        townHall: 18,
        clanTag,
        clanName,
        weight: 12000 - index * 17,
      });
    }

    const firstSession = makeInteraction({
      subcommand: "set",
      targetUserId: "222222222222222222",
    });
    await runFillers(firstSession);

    const firstPayload = getLastEditPayload(firstSession);
    const firstComponents = getComponentJson(firstPayload);
    const firstMenu = firstComponents[0].components[0];
    const firstSelection = [
      String(firstMenu.options[0].value),
      String(firstMenu.options[1].value),
    ];

    await firstSession.__collectorHandlers.collect(
      makeSelectInteraction({
        customId: firstMenu.custom_id ?? firstMenu.customId,
        values: firstSelection,
      }),
    );

    const firstClanList = makeInteraction({
      subcommand: "list",
      clan: clanTag,
    });
    await runFillers(firstClanList);
    const firstClanEmbed = getEmbedJson(getLastEditPayload(firstClanList));
    const firstClanDescription = String(firstClanEmbed.description);
    expect(firstClanDescription).toContain(String(playerNameByTag.get(firstSelection[0]) ?? ""));
    expect(firstClanDescription).toContain(String(playerNameByTag.get(firstSelection[1]) ?? ""));

    const secondSession = makeInteraction({
      subcommand: "set",
      targetUserId: "222222222222222222",
    });
    await runFillers(secondSession);

    const secondPayload = getLastEditPayload(secondSession);
    const secondComponents = getComponentJson(secondPayload);
    const secondMenu = secondComponents[0].components[0];
    expect(secondMenu.options[0].default).toBe(true);
    expect(secondMenu.options[1].default).toBe(true);

    const nextButton = secondComponents.at(-1)?.components?.find((component: any) =>
      String(component.custom_id ?? component.customId ?? "").endsWith(":next"),
    );
    expect(nextButton).toBeTruthy();

    const nextInteraction = makeButtonInteraction({
      customId: nextButton.custom_id ?? nextButton.customId,
    });
    await secondSession.__collectorHandlers.collect(nextInteraction);

    const nextPayload = getLastInteractionUpdatePayload(nextInteraction);
    const nextComponents = getComponentJson(nextPayload);
    const nextMenu = nextComponents[0].components[0];
    const secondSelection = [
      String(nextMenu.options[0].value),
      String(nextMenu.options[1].value),
    ].filter((tag) => !firstSelection.includes(tag));

    expect(secondSelection).toHaveLength(2);

    await secondSession.__collectorHandlers.collect(
      makeSelectInteraction({
        customId: nextMenu.custom_id ?? nextMenu.customId,
        values: secondSelection,
      }),
    );

    const secondClanList = makeInteraction({
      subcommand: "list",
      clan: clanTag,
    });
    await runFillers(secondClanList);
    const secondClanEmbed = getEmbedJson(getLastEditPayload(secondClanList));
    const secondClanDescription = String(secondClanEmbed.description);
    for (const tag of [...firstSelection, ...secondSelection]) {
      expect(secondClanDescription).toContain(String(playerNameByTag.get(tag) ?? ""));
    }
    expect(secondClanDescription).not.toContain("No filler accounts are currently in clan");
  });

  it("lists filler accounts by guild, user, and clan using persisted filler state only", async () => {
    seedAccount({
      playerTag: "#P0000",
      discordUserId: "222222222222222222",
      playerName: "Alpha",
      townHall: 18,
      clanTag: "#PQL0289",
      clanName: "Alpha Clan",
      weight: 9200,
    });
    seedAccount({
      playerTag: "#P0002",
      discordUserId: "222222222222222222",
      playerName: "Beta",
      townHall: 17,
      clanTag: "#QGRJ2222",
      clanName: "Beta Clan",
      weight: 8400,
    });
    seedAccount({
      playerTag: "#P0008",
      discordUserId: "333333333333333333",
      playerName: "Gamma",
      townHall: 16,
      clanTag: "#QGRJ2222",
      clanName: "Beta Clan",
      weight: 7300,
    });
    fillerState.add("#P0000");
    fillerState.add("#P0008");

    const allInteraction = makeInteraction({ subcommand: "list" });
    await runFillers(allInteraction);
    const allEmbed = getEmbedJson(getLastEditPayload(allInteraction));
    const allDescription = String(allEmbed.description);
    expect(String(allEmbed.title)).toBe("Filler Accounts (2)");
    expect(allDescription).toContain("**[Alpha Clan](");
    expect(allDescription).toContain("**[Beta Clan](");
    expect(allDescription).toContain("**<@222222222222222222>**");
    expect(allDescription).toContain("**<@333333333333333333>**");
    expect(allDescription).toContain("🧍‍♂️");
    expect(allDescription.indexOf("**[Alpha Clan](")).toBeLessThan(
      allDescription.indexOf("**<@222222222222222222>**"),
    );
    expect(allDescription.indexOf("**[Beta Clan](")).toBeLessThan(
      allDescription.indexOf("**<@333333333333333333>**"),
    );
    expect(allDescription.indexOf("**[Alpha Clan](")).toBeLessThan(
      allDescription.indexOf("**[Beta Clan]("),
    );

    const userInteraction = makeInteraction({
      subcommand: "list",
      targetUserId: "222222222222222222",
    });
    await runFillers(userInteraction);
    const userEmbed = getEmbedJson(getLastEditPayload(userInteraction));
    expect(String(userEmbed.title)).toBe("Filler Accounts (1)");
    expect(String(userEmbed.description)).toContain("User: <@222222222222222222>");
    expect(String(userEmbed.description)).toContain("Alpha");
    expect(String(userEmbed.description)).not.toContain("Gamma");
    expect(String(userEmbed.description)).not.toContain("Clan membership uses saved account data");

    const clanInteraction = makeInteraction({
      subcommand: "list",
      clan: "#QGRJ2222",
    });
    await runFillers(clanInteraction);
    const clanEmbed = getEmbedJson(getLastEditPayload(clanInteraction));
    expect(String(clanEmbed.title)).toBe("Filler Accounts in Beta Clan (1)");
    expect(String(clanEmbed.description)).toContain("Gamma");
    expect(String(clanEmbed.description)).not.toContain("Alpha");
    expect(String(clanEmbed.description)).toContain(
      "Clan membership uses saved account data. If accounts are missing after moving clans, run /accounts and Refresh.",
    );

    const allListEmbed = getEmbedJson(getLastEditPayload(allInteraction));
    expect(String(allListEmbed.description)).not.toContain("Clan membership uses saved account data");
  });

  it("groups the default filler list by clan first, then user, then account", async () => {
    seedAccount({
      playerTag: "#P0000",
      discordUserId: "111111111111111111",
      playerName: "Alpha One",
      townHall: 18,
      clanTag: "#PQL0289",
      clanName: "Alpha Clan",
      weight: 9200,
    });
    seedAccount({
      playerTag: "#P0002",
      discordUserId: "111111111111111111",
      playerName: "Alpha Two",
      townHall: 17,
      clanTag: "#PQL0289",
      clanName: "Alpha Clan",
      weight: 9100,
    });
    seedAccount({
      playerTag: "#P0008",
      discordUserId: "222222222222222222",
      playerName: "Beta One",
      townHall: 16,
      clanTag: "#QGRJ2222",
      clanName: "Beta Clan",
      weight: 8400,
    });
    const unlinkedTag = makeValidPlayerTag(42);
    playerCurrentFixtures.set(
      unlinkedTag,
      makePlayerCurrentRow({
        playerTag: unlinkedTag,
        playerName: "Unlinked Filler",
        townHall: 15,
        clanTag: "#QGRJ2222",
        clanName: "Beta Clan",
        weight: 7300,
      }),
    );
    fillerState.add("#P0000");
    fillerState.add("#P0002");
    fillerState.add("#P0008");
    fillerState.add(unlinkedTag);

    const interaction = makeInteraction({ subcommand: "list" });
    await runFillers(interaction);
    const embed = getEmbedJson(getLastEditPayload(interaction));
    const description = String(embed.description);

    expect(description).toContain("**[Alpha Clan](");
    expect(description).toContain("**[Beta Clan](");
    expect(description).toContain("**<@111111111111111111>**");
    expect(description).toContain("**<@222222222222222222>**");
    expect(description).toContain("**Unlinked**");
    expect(description.indexOf("**[Alpha Clan](")).toBeLessThan(
      description.indexOf("**<@111111111111111111>**"),
    );
    expect(description.indexOf("**[Beta Clan](")).toBeLessThan(
      description.indexOf("**<@222222222222222222>**"),
    );
    expect(description.indexOf("**[Alpha Clan](")).toBeLessThan(
      description.indexOf("**[Beta Clan]("),
    );
    expect(description).toContain("Alpha One");
    expect(description).toContain("Alpha Two");
    expect(description).toContain("Beta One");
    expect(description).toContain("Unlinked Filler");
  });

  it("keeps the clan membership note visible across paginated clan lists", async () => {
    const clanTag = "#PQL0289";
    for (let index = 0; index < 40; index += 1) {
      seedAccount({
        playerTag: makeValidPlayerTag(index),
        discordUserId: "222222222222222222",
        playerName: `Clan Member ${String(index + 1).padStart(2, "0")} With A Long Display Name`,
        townHall: 18,
        clanTag,
        clanName: "Alpha Clan",
        weight: 9000 - index,
      });
      fillerState.add(makeValidPlayerTag(index));
    }

    const interaction = makeInteraction({
      subcommand: "list",
      clan: clanTag,
    });

    await runFillers(interaction);

    const firstPayload = getLastEditPayload(interaction);
    const firstEmbed = getEmbedJson(firstPayload);
    const firstComponents = getComponentJson(firstPayload);
    expect(String(firstEmbed.description)).toContain(
      "Clan membership uses saved account data. If accounts are missing after moving clans, run /accounts and Refresh.",
    );

    const nextButton = firstComponents
      .at(-1)
      ?.components?.find((component: any) => String(component.custom_id ?? component.customId ?? "").endsWith(":next"));
    expect(nextButton).toBeTruthy();

    const nextInteraction = makeButtonInteraction({
      customId: nextButton.custom_id ?? nextButton.customId,
    });
    await interaction.__collectorHandlers.collect(nextInteraction);

    const nextPayload = getLastInteractionUpdatePayload(nextInteraction);
    const nextEmbed = getEmbedJson(nextPayload);
    expect(String(nextEmbed.description)).toContain(
      "Clan membership uses saved account data. If accounts are missing after moving clans, run /accounts and Refresh.",
    );

    const nextComponents = getComponentJson(nextPayload);
    const prevButton = nextComponents
      .at(-1)
      ?.components?.find((component: any) => String(component.custom_id ?? component.customId ?? "").endsWith(":prev"));
    expect(prevButton).toBeTruthy();

    const prevInteraction = makeButtonInteraction({
      customId: prevButton.custom_id ?? prevButton.customId,
    });
    await interaction.__collectorHandlers.collect(prevInteraction);

    const prevPayload = getLastInteractionUpdatePayload(prevInteraction);
    const prevEmbed = getEmbedJson(prevPayload);
    expect(String(prevEmbed.description)).toContain(
      "Clan membership uses saved account data. If accounts are missing after moving clans, run /accounts and Refresh.",
    );
  });

  it("renders the targeted user mention in the filler editor body instead of the title", async () => {
    seedAccount({
      playerTag: "#P0000",
      discordUserId: "222222222222222222",
      playerName: "Alpha",
      townHall: 18,
      clanTag: "#PQL0289",
      clanName: "Alpha Clan",
      weight: 9200,
    });

    const interaction = makeInteraction({
      subcommand: "set",
      targetUserId: "222222222222222222",
    });

    await runFillers(interaction);

    const payload = getLastEditPayload(interaction);
    const embed = getEmbedJson(payload);

    expect(String(embed.title)).toBe("Filler Accounts (1)");
    expect(String(embed.title)).not.toContain("<@222222222222222222>");
    expect(String(embed.description)).toContain("User: <@222222222222222222>");
    expect(String(embed.description)).toContain("Alpha");
  });

  it("allows configured FWA leader users to use fillers commands and denies others", async () => {
    const settings = {
      get: vi.fn(async (key: string) => {
        if (key === `${FWA_LEADER_ROLE_SETTING_KEY}:guild-1`) {
          return "123456789012345678";
        }
        return null;
      }),
    };
    const service = new CommandPermissionService(settings as any);

    const allowedInteraction = {
      guildId: "guild-1",
      user: { id: "111111111111111111" },
      inGuild: vi.fn().mockReturnValue(true),
      memberPermissions: {
        has: vi.fn().mockReturnValue(false),
      },
      member: {
        roles: {
          cache: new Map([["123456789012345678", { id: "123456789012345678" }]]),
        },
      },
    } as any;

    const deniedInteraction = {
      guildId: "guild-1",
      user: { id: "222222222222222222" },
      inGuild: vi.fn().mockReturnValue(true),
      memberPermissions: {
        has: vi.fn().mockReturnValue(false),
      },
      member: {
        roles: {
          cache: new Map(),
        },
      },
    } as any;

    await expect(service.canUseCommand("fillers:list", allowedInteraction)).resolves.toBe(true);
    await expect(service.canUseCommand("fillers:set", allowedInteraction)).resolves.toBe(true);
    await expect(service.canUseCommand("fillers:list", deniedInteraction)).resolves.toBe(false);
    await expect(service.canUseCommand("fillers:set", deniedInteraction)).resolves.toBe(false);
  });
});
