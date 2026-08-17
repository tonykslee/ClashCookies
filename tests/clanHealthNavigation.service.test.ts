import { beforeEach, describe, expect, it, vi } from "vitest";

const permissionMock = vi.hoisted(() => ({ canUseAnyTarget: vi.fn() }));
const inactiveMock = vi.hoisted(() => ({ run: vi.fn() }));
const unlinkedMock = vi.hoisted(() => ({
  buildUnlinkedListLines: vi.fn(),
  listPersistedUnlinkedMembers: vi.fn(),
}));
const compoMock = vi.hoisted(() => ({
  buildCompoAdviceResponsePayload: vi.fn(),
  readAdvice: vi.fn(),
}));
const violationsMock = vi.hoisted(() => ({
  buildFwaViolationsClanDetailPayload: vi.fn(),
}));

vi.mock("../src/services/CommandPermissionService", () => ({
  CommandPermissionService: class {
    canUseAnyTarget = permissionMock.canUseAnyTarget;
  },
}));
vi.mock("../src/commands/Inactive", () => ({
  runInactiveClanHealthDetail: inactiveMock.run,
}));
vi.mock("../src/commands/Unlinked", () => ({
  buildUnlinkedListLines: unlinkedMock.buildUnlinkedListLines,
}));
vi.mock("../src/services/UnlinkedMemberAlertService", () => ({
  unlinkedMemberAlertService: {
    listPersistedUnlinkedMembers: unlinkedMock.listPersistedUnlinkedMembers,
  },
}));
vi.mock("../src/commands/Compo", () => ({
  buildCompoAdviceResponsePayload: compoMock.buildCompoAdviceResponsePayload,
}));
vi.mock("../src/services/CompoAdviceService", () => ({
  CompoAdviceService: class {
    readAdvice = compoMock.readAdvice;
  },
}));
vi.mock("../src/commands/fwa/violationsCommand", () => ({
  buildFwaViolationsClanDetailPayload: violationsMock.buildFwaViolationsClanDetailPayload,
}));

import {
  buildClanHealthNavigationCustomId,
  buildClanHealthNavigationRow,
  handleClanHealthNavigationButtonInteraction,
  parseClanHealthNavigationCustomId,
} from "../src/commands/ClanHealthNavigation";

function makeButton(customId: string, userId = "leader-1") {
  return {
    customId,
    guildId: "guild-1",
    user: { id: userId },
    client: {},
    inGuild: () => true,
    deferred: false,
    replied: false,
    reply: vi.fn().mockResolvedValue(undefined),
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    message: { edit: vi.fn() },
  };
}

describe("Clan Health navigation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    permissionMock.canUseAnyTarget.mockResolvedValue(true);
    unlinkedMock.buildUnlinkedListLines.mockReturnValue([
      "Current unresolved unlinked players in #AAA111:",
      "- none",
    ]);
    unlinkedMock.listPersistedUnlinkedMembers.mockResolvedValue([]);
    compoMock.readAdvice.mockResolvedValue({ kind: "ready", selectedView: "auto" });
    compoMock.buildCompoAdviceResponsePayload.mockResolvedValue({ embeds: [] });
    violationsMock.buildFwaViolationsClanDetailPayload.mockResolvedValue({ embeds: [] });
  });

  it("builds exactly four bounded buttons with deterministic IDs", () => {
    const row = buildClanHealthNavigationRow("#AAA111").toJSON();
    expect(row.components).toHaveLength(4);
    expect(row.components.map((button) => button.label)).toEqual([
      "View Inactive",
      "View Unlinked",
      "View Compo",
      "View Violations",
    ]);
    expect(row.components.map((button) => button.custom_id)).toEqual([
      "clan-health:inactive:AAA111",
      "clan-health:unlinked:AAA111",
      "clan-health:compo:AAA111",
      "clan-health:violations:AAA111",
    ]);
    expect(row.components.every((button) => (button.custom_id?.length ?? 0) <= 100)).toBe(true);
  });

  it("round-trips normalized action and clan tag and rejects malformed IDs", () => {
    const id = buildClanHealthNavigationCustomId("compo", "#pylq02");
    expect(id).toBe("clan-health:compo:PYLQ02");
    expect(parseClanHealthNavigationCustomId(id)).toEqual({
      action: "compo",
      clanTag: "PYLQ02",
    });
    expect(parseClanHealthNavigationCustomId("clan-health:unknown:PYLQ02")).toBeNull();
    expect(parseClanHealthNavigationCustomId("clan-health:compo:#PYLQ02")).toBeNull();
    expect(parseClanHealthNavigationCustomId("clan-health:compo:")).toBeNull();
  });

  it.each([
    ["inactive", ["inactive"], "#AAA111"],
    ["unlinked", ["unlinked:list", "unlinked"], "#AAA111"],
    ["compo", ["compo:advice"], "#AAA111"],
    ["violations", ["fwa:violations"], "#AAA111"],
  ] as const)("routes %s to its owning workflow with an ephemeral response", async (action, target, clanTag) => {
    const interaction = makeButton(buildClanHealthNavigationCustomId(action, clanTag));
    await handleClanHealthNavigationButtonInteraction(interaction as any);

    expect(permissionMock.canUseAnyTarget).toHaveBeenCalledWith(target, interaction);
    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(interaction.message.edit).not.toHaveBeenCalled();
    expect(interaction.update).toBeUndefined();
  });

  it("keeps the originating clan scope for inactive, unlinked, compo, and violations", async () => {
    await handleClanHealthNavigationButtonInteraction(
      makeButton(buildClanHealthNavigationCustomId("inactive", "#AAA111")) as any,
    );
    expect(inactiveMock.run).toHaveBeenCalledWith(expect.anything(), { clanTag: "#AAA111" });

    await handleClanHealthNavigationButtonInteraction(
      makeButton(buildClanHealthNavigationCustomId("unlinked", "#AAA111")) as any,
    );
    expect(unlinkedMock.listPersistedUnlinkedMembers).toHaveBeenCalledWith({
      guildId: "guild-1",
      clanTag: "#AAA111",
    });

    await handleClanHealthNavigationButtonInteraction(
      makeButton(buildClanHealthNavigationCustomId("compo", "#AAA111")) as any,
    );
    expect(compoMock.readAdvice).toHaveBeenCalledWith({
      guildId: "guild-1",
      targetTag: "#AAA111",
      mode: "actual",
      view: "auto",
    });

    await handleClanHealthNavigationButtonInteraction(
      makeButton(buildClanHealthNavigationCustomId("violations", "#AAA111")) as any,
    );
    expect(violationsMock.buildFwaViolationsClanDetailPayload).toHaveBeenCalledWith(
      expect.objectContaining({ guildId: "guild-1", clanTag: "#AAA111" }),
    );
  });

  it("does not bind the tracked-clan button to the original command user", async () => {
    const firstLeader = makeButton(
      buildClanHealthNavigationCustomId("compo", "#AAA111"),
      "leader-1",
    );
    const secondLeader = makeButton(
      buildClanHealthNavigationCustomId("compo", "#AAA111"),
      "leader-2",
    );

    await handleClanHealthNavigationButtonInteraction(firstLeader as any);
    await handleClanHealthNavigationButtonInteraction(secondLeader as any);

    expect(compoMock.readAdvice).toHaveBeenCalledTimes(2);
    expect(permissionMock.canUseAnyTarget).toHaveBeenNthCalledWith(1, ["compo:advice"], firstLeader);
    expect(permissionMock.canUseAnyTarget).toHaveBeenNthCalledWith(2, ["compo:advice"], secondLeader);
  });

  it("fails malformed IDs safely and enforces permission denial", async () => {
    const malformed = makeButton("clan-health:wat:AAA111");
    await handleClanHealthNavigationButtonInteraction(malformed as any);
    expect(malformed.reply).toHaveBeenCalledWith(
      expect.objectContaining({ ephemeral: true }),
    );

    permissionMock.canUseAnyTarget.mockResolvedValue(false);
    const denied = makeButton(buildClanHealthNavigationCustomId("compo", "#AAA111"));
    await handleClanHealthNavigationButtonInteraction(denied as any);
    expect(denied.reply).toHaveBeenCalledWith(
      expect.objectContaining({ ephemeral: true }),
    );
    expect(denied.deferReply).not.toHaveBeenCalled();
  });
});
