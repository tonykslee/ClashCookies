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
    replied: false,
    deferred: false,
    reply: vi.fn().mockResolvedValue(undefined),
  };
}

function getLastEditPayload(interaction: any): any {
  return interaction.editReply.mock.calls.at(-1)?.[0] ?? {};
}

function getEmbedJson(payload: any): any {
  const embed = payload?.embeds?.[0];
  return embed?.toJSON?.() ?? embed ?? {};
}

function getComponentJson(payload: any): any[] {
  return (payload?.components ?? []).map((component: any) => component.toJSON?.() ?? component);
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

    const rerenderPayload = select.update.mock.calls.at(-1)?.[0];
    const rerenderComponents = getComponentJson(rerenderPayload);
    const rerenderMenu = rerenderComponents[0].components[0];
    expect(rerenderMenu.options[0].default).toBe(true);
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

    expect(String(embed.title)).toBe("Filler Accounts (126)");
    expect(String(embed.footer?.text)).toContain("0/126 filler accounts selected");
    expect(String(embed.footer?.text)).toContain("Page 1/6");
    expect(components).toHaveLength(2);
    expect(components[0].components).toHaveLength(1);
    expect(components[1].components).toHaveLength(2);

    const firstMenu = components[0].components[0];
    expect(firstMenu.options).toHaveLength(25);
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

    for (let index = 0; index < 59; index += 1) {
      const tag = makeValidPlayerTag(index);
      const clanName = `The Extremely Long And Verbose Clan Name For Production Diagnostics ${String(index + 1).padStart(2, "0")} [FWA]`;
      seedAccount({
        playerTag: tag,
        discordUserId: "222222222222222222",
        playerName: `Teewizz Candidate ${String(index + 1).padStart(2, "0")} With An Exceptionally Long Display Name For Markdown Rendering`,
        townHall: index % 2 === 0 ? 18 : 17,
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
    const firstMenu = components[0].components[0];

    expect(String(embed.description)).toContain("more account(s) on this page are not shown in the preview");
    expect(String(embed.description)).toContain("remain selectable in the dropdown below");
    expect(String(embed.description).length).toBeLessThanOrEqual(4096);
    expect(firstMenu.options).toHaveLength(25);
    expect(String(embed.description)).toContain("<:town_hall_custom_18:12345678901234567>");
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
    const selectAlphaPayload = selectAlpha.update.mock.calls.at(-1)?.[0];
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
    expect(String(allEmbed.title)).toBe("Filler Accounts (2)");
    expect(String(allEmbed.description)).toContain("**<@222222222222222222>**");
    expect(String(allEmbed.description)).toContain("**<@333333333333333333>**");
    expect(String(allEmbed.description)).toContain("🧍‍♂️");

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

    const clanInteraction = makeInteraction({
      subcommand: "list",
      clan: "#QGRJ2222",
    });
    await runFillers(clanInteraction);
    const clanEmbed = getEmbedJson(getLastEditPayload(clanInteraction));
    expect(String(clanEmbed.title)).toBe("Filler Accounts in Beta Clan (1)");
    expect(String(clanEmbed.description)).toContain("Gamma");
    expect(String(clanEmbed.description)).not.toContain("Alpha");
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
