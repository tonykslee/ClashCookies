import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  trackedClan: {
    findFirst: vi.fn(),
  },
}));

const recruitmentServiceMock = vi.hoisted(() => ({
  getRecruitmentCooldown: vi.fn(),
  getRecruitmentTemplate: vi.fn(),
  upsertRecruitmentTemplate: vi.fn(),
}));
const recruitmentPreferenceMock = vi.hoisted(() => ({
  isEnabled: vi.fn(),
  setEnabled: vi.fn(),
}));

vi.mock("../src/prisma", () => ({
  prisma: prismaMock,
}));

vi.mock("../src/services/RecruitmentService", async () => {
  const actual = await vi.importActual("../src/services/RecruitmentService");
  return {
    ...actual,
    getRecruitmentCooldown: recruitmentServiceMock.getRecruitmentCooldown,
    getRecruitmentTemplate: recruitmentServiceMock.getRecruitmentTemplate,
    upsertRecruitmentTemplate: recruitmentServiceMock.upsertRecruitmentTemplate,
  };
});

vi.mock("../src/services/RecruitmentCountdownReminderPreferenceService", () => ({
  recruitmentCountdownReminderPreferenceService: recruitmentPreferenceMock,
}));

import { Recruitment, handleRecruitmentModalSubmit } from "../src/commands/Recruitment";

function createEditInteraction(input?: { clan?: string; platform?: string }) {
  return {
    guildId: "guild-1",
    user: { id: "user-1" },
    deferred: false,
    replied: false,
    options: {
      getSubcommandGroup: vi.fn().mockReturnValue(null),
      getSubcommand: vi.fn().mockReturnValue("edit"),
      getString: vi.fn((name: string) => {
        if (name === "clan") return input?.clan ?? "PQL0289";
        if (name === "platform") return input?.platform ?? "band";
        return null;
      }),
    },
    reply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    showModal: vi.fn().mockResolvedValue(undefined),
  };
}

function createShowInteraction(input: { clan: string; platform: "discord" | "reddit" | "band" }) {
  return {
    guildId: "guild-1",
    user: { id: "user-1" },
    deferred: false,
    replied: false,
    options: {
      getSubcommandGroup: vi.fn().mockReturnValue(null),
      getSubcommand: vi.fn().mockReturnValue("show"),
      getString: vi.fn((name: string) => {
        if (name === "clan") return input.clan;
        if (name === "platform") return input.platform;
        return null;
      }),
    },
    reply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    showModal: vi.fn().mockResolvedValue(undefined),
    deferReply: vi.fn().mockResolvedValue(undefined),
  };
}

function createBandModalSubmitInteraction() {
  return {
    guildId: "guild-1",
    user: { id: "user-1" },
    customId: "recruitment-edit:user-1:PQL0289:band",
    deferred: false,
    replied: false,
    reply: vi.fn().mockResolvedValue(undefined),
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    fields: {
      getTextInputValue: vi.fn((name: string) => {
        if (name === "body") return "Band body";
        if (name === "image-urls") return "https://img1.example/a.png, https://img2.example/b.png";
        return "";
      }),
    },
  };
}

describe("/recruitment command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.trackedClan.findFirst.mockResolvedValue({
      tag: "#PQL0289",
      name: "Clan One",
    });
    recruitmentServiceMock.getRecruitmentCooldown.mockResolvedValue(null);
    recruitmentServiceMock.getRecruitmentTemplate.mockResolvedValue(null);
    recruitmentServiceMock.upsertRecruitmentTemplate.mockResolvedValue(undefined);
    recruitmentPreferenceMock.isEnabled.mockResolvedValue(true);
    recruitmentPreferenceMock.setEnabled.mockResolvedValue(undefined);
  });

  it("opens band edit modal when no guild-scoped template exists yet", async () => {
    const interaction = createEditInteraction({ platform: "band", clan: "pql0289" });

    await Recruitment.run({} as any, interaction as any, {} as any);

    expect(recruitmentServiceMock.getRecruitmentTemplate).toHaveBeenCalledWith(
      "guild-1",
      "PQL0289",
      "band",
    );
    expect(interaction.showModal).toHaveBeenCalledTimes(1);
    const modal = interaction.showModal.mock.calls[0]?.[0];
    const payload = modal?.toJSON() as any;
    const inputIds = (payload?.components ?? []).map(
      (row: { components?: Array<{ custom_id?: string }> }) => row.components?.[0]?.custom_id,
    );
    expect(inputIds).toEqual(["body", "image-urls"]);
    expect(inputIds).not.toContain("discord-clan-tag");
    expect(inputIds).not.toContain("reddit-subject");
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it("returns targeted recruitment setup error instead of generic failure when edit setup throws", async () => {
    recruitmentServiceMock.getRecruitmentTemplate.mockRejectedValue(
      new Error("duplicate key value violates unique constraint"),
    );
    const interaction = createEditInteraction({ platform: "band", clan: "PQL0289" });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await Recruitment.run({} as any, interaction as any, {} as any);

    expect(interaction.reply).toHaveBeenCalledWith({
      ephemeral: true,
      content:
        "Failed to open recruitment editor. Check recruitment database migration/state and try again.",
    });
    expect(interaction.showModal).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "[recruitment] edit_setup_failed guildId=guild-1 clanTag=PQL0289 platform=band userId=user-1",
      ),
    );
  });

  it("submitting a band recruitment modal creates a guild-scoped template with no subject", async () => {
    const interaction = createBandModalSubmitInteraction();

    await handleRecruitmentModalSubmit(interaction as any);

    expect(recruitmentServiceMock.upsertRecruitmentTemplate).toHaveBeenCalledWith({
      guildId: "guild-1",
      clanTag: "PQL0289",
      platform: "band",
      subject: null,
      body: "Band body",
      imageUrls: ["https://img1.example/a.png", "https://img2.example/b.png"],
    });
    expect(interaction.fields.getTextInputValue).not.toHaveBeenCalledWith("reddit-subject");
    expect(interaction.fields.getTextInputValue).not.toHaveBeenCalledWith("discord-clan-tag");
    expect(interaction.editReply).toHaveBeenCalledWith(
      "Saved band recruitment template for Clan One (#PQL0289).",
    );
  });

  it("renders double-backtick recruitment output and platform links in show output", async () => {
    recruitmentServiceMock.getRecruitmentTemplate.mockImplementation(async (_guildId: string, _clanTag: string, platform: string) => {
      if (platform === "reddit") {
        return {
          subject: "Alpha Reddit",
          body: "Alpha reddit body",
          imageUrls: [],
        } as any;
      }
      if (platform === "band") {
        return {
          subject: null,
          body: "Band body",
          imageUrls: [],
        } as any;
      }
      return null;
    });

    const redditInteraction = createShowInteraction({ clan: "PQL0289", platform: "reddit" });
    await Recruitment.run({} as any, redditInteraction as any, {} as any);

    expect(redditInteraction.editReply).toHaveBeenCalledTimes(1);
    const redditPayload = redditInteraction.editReply.mock.calls[0]?.[0] as string;
    expect(redditPayload).toContain("https://www.reddit.com/r/ClashOfClansRecruit/");
    expect(redditPayload).toContain("``Alpha reddit body``");

    const bandInteraction = createShowInteraction({ clan: "PQL0289", platform: "band" });
    await Recruitment.run({} as any, bandInteraction as any, {} as any);

    expect(bandInteraction.editReply).toHaveBeenCalledTimes(1);
    const bandPayload = bandInteraction.editReply.mock.calls[0]?.[0] as string;
    expect(bandPayload).toContain("https://www.band.us/band/67130116/post");
    expect(bandPayload).toContain("``Band body``");
  });

  it("exposes countdown reminder settings under the countdown group", async () => {
    const countdownGroup = Recruitment.options.find((option) => option.name === "countdown") as any;
    expect(countdownGroup).toBeTruthy();
    const settings = (countdownGroup?.options ?? []).find(
      (option: { name?: string }) => option.name === "settings",
    ) as any;
    expect(settings).toBeTruthy();
    expect(
      (settings?.options ?? []).some((option: { name?: string }) => option.name === "reminders"),
    ).toBe(true);
  });

  it("persists countdown reminder preferences from the settings subcommand", async () => {
    const interaction = {
      guildId: "guild-1",
      user: { id: "user-1" },
      deferred: false,
      replied: false,
      options: {
        getSubcommandGroup: vi.fn().mockReturnValue("countdown"),
        getSubcommand: vi.fn().mockReturnValue("settings"),
        getBoolean: vi.fn().mockReturnValue(false),
      },
      reply: vi.fn().mockResolvedValue(undefined),
      deferReply: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
    };

    await Recruitment.run({} as any, interaction as any, {} as any);

    expect(recruitmentPreferenceMock.setEnabled).toHaveBeenCalledWith({
      guildId: "guild-1",
      userId: "user-1",
      enabled: false,
    });
    expect(interaction.editReply).toHaveBeenCalledWith(
      "Recruitment reminder pings are now disabled for your cooldown timers.",
    );
  });
});
