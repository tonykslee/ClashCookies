import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  trackedClan: {
    findMany: vi.fn(),
  },
  clanWarHistory: {
    findFirst: vi.fn(),
  },
  apiUsage: {
    upsert: vi.fn(() => Promise.resolve(undefined)),
  },
}));

const fwaPoliceServiceMock = vi.hoisted(() => ({
  setClanConfig: vi.fn(),
  getTemplatePreviewBundle: vi.fn(),
  setClanTemplate: vi.fn(),
  setDefaultTemplate: vi.fn(),
  resetClanTemplate: vi.fn(),
  resetDefaultTemplate: vi.fn(),
  sendSampleMessage: vi.fn(),
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
  hasInitializedPrismaClient: () => false,
}));

vi.mock("../src/services/FwaPoliceService", () => ({
  fwaPoliceService: fwaPoliceServiceMock,
}));

import { Fwa } from "../src/commands/Fwa";
import { PointsSyncService } from "../src/services/PointsSyncService";

function makeInteraction(input: {
  subcommand:
    | "configure"
    | "show"
    | "show-default"
    | "show-all"
    | "set"
    | "set-default"
    | "reset"
    | "reset-default"
    | "send";
  clan: string;
  violation?: string;
  template?: string;
  show?: "DM" | "LOG";
  enableDm?: boolean;
  enableLog?: boolean;
}) {
  const deferReply = vi.fn().mockResolvedValue(undefined);
  const editReply = vi.fn().mockResolvedValue(undefined);
  const interaction = {
    id: "interaction-1",
    guildId: "guild-1",
    channelId: "channel-1",
    user: { id: "111111111111111111" },
    client: {},
    memberPermissions: {
      has: vi.fn(() => true),
    },
    deferReply,
    editReply,
    inGuild: vi.fn(() => true),
    options: {
      getSubcommandGroup: vi.fn(() => "police"),
      getSubcommand: vi.fn(() => input.subcommand),
      getString: vi.fn((name: string) => {
        if (name === "visibility") return null;
        if (name === "clan") return input.clan;
        if (name === "violation") return input.violation ?? null;
        if (name === "template") return input.template ?? null;
        if (name === "show") return input.show ?? null;
        if (name === "tag") return null;
        return null;
      }),
      getBoolean: vi.fn((name: string) => {
        if (name === "enable-dm") return input.enableDm ?? null;
        if (name === "enable-log") return input.enableLog ?? null;
        return null;
      }),
    },
  };
  return { interaction, deferReply, editReply };
}

describe("/fwa police command output", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(PointsSyncService.prototype, "findLatestSyncNum").mockResolvedValue(
      null,
    );
    prismaMock.trackedClan.findMany.mockResolvedValue([]);
    prismaMock.clanWarHistory.findFirst.mockResolvedValue(null);
    fwaPoliceServiceMock.getTemplatePreviewBundle.mockResolvedValue({
      clanTag: "#2QG2C08UP",
      clanName: "Alpha",
      contextSummary:
        "Match type context: FWA WIN | Lose style: TRIPLE_TOP_30 | Free-for-all star threshold: 101 | Free-for-all time threshold: 0h",
      rows: [
        {
          violation: "EARLY_NON_MIRROR_TRIPLE",
          label: "Early non-mirror triple before FFA window",
          effectiveSource: "Built-in",
          rawCustomTemplate: null,
          rawDefaultTemplate: null,
          effectiveTemplate: "{offender} sample",
          renderedSample: "#15 - Tilonius sample",
          sampleEmbed: {
            color: 0xed4245,
            description:
              "## :rotating_light: :oncoming_police_car: FWA Police - Warplan violation detected :oncoming_police_car: :rotating_light:\n**War**: FWA-WIN :green_circle:\n**Violation**: Early non-mirror triple before FFA window",
            fields: [
              {
                name: "**Message**",
                value: "#15 - Tilonius sample",
                inline: false,
              },
              {
                name: "**:yes: Expected**",
                value: "Wait for FFA window before any non-mirror triple.",
                inline: false,
              },
              {
                name: "**:no: Actual**",
                value: "#14 (* * *) : tripled non-mirror before FFA window",
                inline: false,
              },
            ],
          },
          isApplicable: true,
          applicabilityText: "Applicable",
        },
      ],
    });
    fwaPoliceServiceMock.resetClanTemplate.mockResolvedValue({ ok: true });
    fwaPoliceServiceMock.setClanTemplate.mockResolvedValue({ ok: true });
    fwaPoliceServiceMock.setDefaultTemplate.mockResolvedValue({ ok: true });
    fwaPoliceServiceMock.sendSampleMessage.mockResolvedValue({
      ok: true,
      deliveredTo: "DM",
      rendered: "sample",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders configure summary and persists toggle values", async () => {
    fwaPoliceServiceMock.setClanConfig.mockResolvedValue({
      clanTag: "#2QG2C08UP",
      clanName: "Alpha",
      enableDm: true,
      enableLog: false,
    });

    const run = makeInteraction({
      subcommand: "configure",
      clan: "2QG2C08UP",
      enableDm: true,
      enableLog: false,
    });
    await Fwa.run({} as any, run.interaction as any, {} as any);

    expect(fwaPoliceServiceMock.setClanConfig).toHaveBeenCalledWith({
      clanTag: "2QG2C08UP",
      enableDm: true,
      enableLog: false,
    });
    const content = String(run.editReply.mock.calls[0]?.[0]?.content ?? "");
    expect(content).toContain("FWA police updated for **Alpha** (#2QG2C08UP).");
    expect(content).toContain("DM alerts: ON | Clan logs: OFF");
  });

  it("shows placeholder validation failure when clan template contains unknown placeholders", async () => {
    fwaPoliceServiceMock.setClanTemplate.mockResolvedValue({
      ok: false,
      error: "INVALID_PLACEHOLDER",
      detail: "bad_token",
    });
    const run = makeInteraction({
      subcommand: "set",
      clan: "#2QG2C08UP",
      violation: "EARLY_NON_MIRROR_TRIPLE",
      template: "Hello {bad_token}",
    });

    await Fwa.run({} as any, run.interaction as any, {} as any);

    const content = String(run.editReply.mock.calls[0]?.[0]?.content ?? "");
    expect(content).toContain("unknown placeholders");
    expect(content).toContain("{offender}");
    expect(content).toContain("{user}");
  });

  it("returns a clear error for send LOG when clan log channel is missing", async () => {
    fwaPoliceServiceMock.sendSampleMessage.mockResolvedValue({
      ok: false,
      error: "LOG_CHANNEL_NOT_CONFIGURED",
    });
    const run = makeInteraction({
      subcommand: "send",
      clan: "#2QG2C08UP",
      violation: "EARLY_NON_MIRROR_TRIPLE",
      show: "LOG",
    });

    await Fwa.run({} as any, run.interaction as any, {} as any);

    const content = String(run.editReply.mock.calls[0]?.[0]?.content ?? "");
    expect(content).toContain("no clan log channel is configured");
  });

  it("renders show output with effective source and rendered sample", async () => {
    const run = makeInteraction({
      subcommand: "show",
      clan: "#2QG2C08UP",
      violation: "EARLY_NON_MIRROR_TRIPLE",
    });

    await Fwa.run({} as any, run.interaction as any, {} as any);

    const payload = run.editReply.mock.calls[0]?.[0];
    const embedJson = payload?.embeds?.[0]?.toJSON?.() ?? null;
    expect(Number(embedJson?.color ?? 0)).toBe(0xed4245);
    expect(String(embedJson?.description ?? "")).toContain(
      "FWA Police - Warplan violation detected",
    );
    expect(String(embedJson?.fields?.[0]?.name ?? "")).toBe("**Message**");
    expect(String(embedJson?.fields?.[3]?.name ?? "")).toBe(
      "**Template Source**",
    );
    expect(String(embedJson?.fields?.[3]?.value ?? "")).toContain("Built-in");
  });

  it("renders show-all as one-violation-per-page pagination", async () => {
    fwaPoliceServiceMock.getTemplatePreviewBundle.mockResolvedValue({
      clanTag: "#2QG2C08UP",
      clanName: "Alpha",
      contextSummary:
        "Match type context: FWA WIN | Lose style: TRIPLE_TOP_30 | Free-for-all star threshold: 101 | Free-for-all time threshold: 0h",
      rows: [
        {
          violation: "EARLY_NON_MIRROR_TRIPLE",
          label: "Early non-mirror triple before FFA window",
          effectiveSource: "Built-in",
          rawCustomTemplate: null,
          rawDefaultTemplate: null,
          effectiveTemplate: "{offender} sample",
          renderedSample: "#15 - Tilonius sample",
          sampleEmbed: {
            color: 0xed4245,
            description:
              "## :rotating_light: :oncoming_police_car: FWA Police - Warplan violation detected :oncoming_police_car: :rotating_light:\n**War**: FWA-WIN :green_circle:\n**Violation**: Early non-mirror triple before FFA window",
            fields: [
              { name: "**Message**", value: "sample 1", inline: false },
              { name: "**:yes: Expected**", value: "expected 1", inline: false },
              { name: "**:no: Actual**", value: "actual 1", inline: false },
            ],
          },
          isApplicable: true,
          applicabilityText: "Applicable",
        },
        {
          violation: "ANY_3STAR",
          label: "Any 3-star in FWA loss (traditional)",
          effectiveSource: "Default",
          rawCustomTemplate: null,
          rawDefaultTemplate: "{offender}",
          effectiveTemplate: "{offender}",
          renderedSample: "#15 - Tilonius",
          sampleEmbed: {
            color: 0xed4245,
            description:
              "## :rotating_light: :oncoming_police_car: FWA Police - Warplan violation detected :oncoming_police_car: :rotating_light:\n**War**: FWA-LOSE :red_circle:\n**Violation**: Any 3-star in FWA loss (traditional)",
            fields: [
              { name: "**Message**", value: "sample 2", inline: false },
              { name: "**:yes: Expected**", value: "expected 2", inline: false },
              { name: "**:no: Actual**", value: "actual 2", inline: false },
            ],
          },
          isApplicable: true,
          applicabilityText: "Applicable",
        },
      ],
    });
    const collector = { on: vi.fn() };
    const run = makeInteraction({
      subcommand: "show-all",
      clan: "#2QG2C08UP",
    });
    const createMessageComponentCollector = vi.fn().mockReturnValue(collector);
    run.editReply.mockResolvedValueOnce({
      createMessageComponentCollector,
    } as any);

    await Fwa.run({} as any, run.interaction as any, {} as any);

    const payload = run.editReply.mock.calls[0]?.[0];
    expect(payload?.components?.length ?? 0).toBe(1);
    expect(
      String(payload?.embeds?.[0]?.toJSON?.()?.footer?.text ?? ""),
    ).toContain("Page 1/2");
    expect(createMessageComponentCollector).toHaveBeenCalledTimes(1);
  });
});
