import { beforeEach, describe, expect, it, vi } from "vitest";
import { DuskAdmin, hasDuskAdministratorPermission } from "../src/commands/DuskAdmin";
import { Commands } from "../src/Commands";
import { duskLedgerService } from "../src/services/DuskLedgerService";
import { hasPermissionTargetForCommand } from "../src/services/CommandPermissionService";

function makeEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: "entry-1",
    walletId: "member-1",
    amount: 10,
    transactionType: "EARNING",
    beneficiaryMode: "SINGLE_RECIPIENT",
    beneficiaryKey: null,
    sourceEventType: "unknown-source",
    sourceEventId: "source-1",
    idempotencyKey: "request-1",
    attribution: null,
    policyVersion: "policy-v1",
    reason: "verified work",
    actorDiscordUserId: "actor-1",
    reversalOfId: null,
    createdAt: new Date("2026-11-12T20:00:00.000Z"),
    policy: null,
    sourceEventClaim: null,
    reversalOf: null,
    reversals: [],
    ...overrides,
  } as any;
}

function makeInteraction(input: { admin?: boolean; memberPresent?: boolean } = {}) {
  const handlers = new Map<string, (value: any) => Promise<void> | void>();
  const collector = {
    on: vi.fn((event: string, callback: (value: any) => Promise<void> | void) => {
      handlers.set(event, callback);
      return collector;
    }),
  };
  const message = {
    createMessageComponentCollector: vi.fn(() => collector),
  };
  const interaction: any = {
    id: "audit-interaction-1",
    commandName: "dusk-admin",
    guildId: "guild-1",
    guild: {
      id: "guild-1",
      members: {
        fetch: vi.fn().mockResolvedValue({
          id: "member-1",
          displayName: "Target Member",
          user: { username: "target" },
        }),
      },
    },
    user: { id: "admin-1" },
    member: input.memberPresent === false ? null : { roles: [] },
    memberPermissions: input.memberPresent === false
      ? null
      : { has: vi.fn(() => input.admin !== false) },
    deferred: false,
    replied: false,
    inGuild: () => true,
    options: {
      getUser: vi.fn(() => ({ id: "member-1" })),
    },
    reply: vi.fn(async () => {
      interaction.replied = true;
    }),
    deferReply: vi.fn(async () => {
      interaction.deferred = true;
    }),
    editReply: vi.fn().mockResolvedValue(undefined),
    fetchReply: vi.fn().mockResolvedValue(message),
  };
  return { interaction, collector, handlers };
}

describe("/dusk-admin audit", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(duskLedgerService, "getBalance").mockResolvedValue(35);
    vi.spyOn(duskLedgerService, "getLifetimeEarned").mockResolvedValue(80);
    vi.spyOn(duskLedgerService, "listAuditEntryPage").mockResolvedValue({
      entries: [makeEntry()],
      hasMore: false,
      nextCursor: null,
    });
    vi.spyOn(duskLedgerService, "listReversalRequests").mockResolvedValue([]);
    vi.spyOn(duskLedgerService, "getSourceEventAudit").mockResolvedValue({
      entry: {
        id: "entry-1",
        walletId: "member-1",
        sourceEventType: "unknown-source",
        sourceEventId: "source-1",
        attribution: null,
      },
      sourceEvent: null,
      claims: [],
      claimRecordedForEntry: false,
      policy: null,
      operationalEvidence: {
        status: "UNKNOWN",
        owner: null,
        summary: "No supported operational evidence owner is registered for this source type.",
        record: null,
      },
    });
  });

  it("registers a separate fixed-private administrator audit target", () => {
    expect(Commands.find((command) => command.name === "dusk-admin")).toBe(DuskAdmin);
    expect(hasPermissionTargetForCommand("dusk-admin")).toBe(true);
    expect(hasPermissionTargetForCommand("dusk-admin:audit")).toBe(true);
    expect(DuskAdmin.suppressVisibilityOption).toBe(true);
    expect(DuskAdmin.options?.[0]?.name).toBe("audit");
  });

  it("fails closed for a clan leader or missing permission evidence", async () => {
    const roleWhitelisted = makeInteraction({ admin: false });
    await DuskAdmin.run({} as any, roleWhitelisted.interaction, {} as any);
    expect(roleWhitelisted.interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ ephemeral: true }),
    );
    expect(duskLedgerService.getBalance).not.toHaveBeenCalled();

    const missingMember = makeInteraction({ memberPresent: false });
    expect(hasDuskAdministratorPermission(missingMember.interaction)).toBe(false);
    await DuskAdmin.run({} as any, missingMember.interaction, {} as any);
    expect(missingMember.interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ ephemeral: true }),
    );
  });

  it("audits only a verified current guild member and never exposes a post button", async () => {
    const { interaction } = makeInteraction({ admin: true });
    await DuskAdmin.run({} as any, interaction, {} as any);

    expect(interaction.guild.members.fetch).toHaveBeenCalledWith("member-1");
    expect(duskLedgerService.getBalance).toHaveBeenCalledWith("member-1");
    expect(duskLedgerService.getLifetimeEarned).toHaveBeenCalledWith("member-1");
    expect(duskLedgerService.listAuditEntryPage).toHaveBeenCalledWith("member-1", null, 5);
    expect(duskLedgerService.listReversalRequests).toHaveBeenCalledWith("member-1", 50);
    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    const response = interaction.editReply.mock.calls[0][0];
    expect(response.allowedMentions).toEqual({ parse: [] });
    expect(response.components.flatMap((row: any) => row.components.map((component: any) => component.data.label))).not.toContain("Post to Channel");
  });

  it("revalidates the invoking administrator on every component interaction", async () => {
    const { interaction, handlers } = makeInteraction({ admin: true });
    await DuskAdmin.run({} as any, interaction, {} as any);
    const collect = handlers.get("collect");
    expect(collect).toBeTypeOf("function");

    const staleButton = {
      customId: "dusk-admin:audit-interaction-1:history",
      user: { id: "admin-1" },
      guildId: "guild-1",
      guild: interaction.guild,
      member: { roles: [] },
      memberPermissions: { has: vi.fn(() => false) },
      inGuild: () => true,
      isStringSelectMenu: () => false,
      isButton: () => true,
      reply: vi.fn(),
      update: vi.fn(),
      replied: false,
      deferred: false,
    };
    await collect?.(staleButton);
    expect(staleButton.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
    expect(staleButton.update).not.toHaveBeenCalled();

    const validButton = {
      ...staleButton,
      memberPermissions: { has: vi.fn(() => true) },
      reply: vi.fn(),
      update: vi.fn(),
    };
    await collect?.(validButton);
    expect(duskLedgerService.listAuditEntryPage).toHaveBeenCalledWith("member-1", null, 8);
    expect(validButton.update).toHaveBeenCalledWith(expect.objectContaining({ allowedMentions: { parse: [] } }));
  });

  it("keeps source references distinct from unsupported operational proof", async () => {
    const { interaction, handlers } = makeInteraction({ admin: true });
    await DuskAdmin.run({} as any, interaction, {} as any);
    const collect = handlers.get("collect");
    const select = {
      customId: "dusk-admin:audit-interaction-1:source",
      values: ["entry-1"],
      user: { id: "admin-1" },
      guildId: "guild-1",
      guild: interaction.guild,
      member: { roles: [] },
      memberPermissions: { has: vi.fn(() => true) },
      inGuild: () => true,
      isStringSelectMenu: () => true,
      isButton: () => false,
      reply: vi.fn(),
      update: vi.fn(),
      replied: false,
      deferred: false,
    };
    await collect?.(select);
    expect(duskLedgerService.getSourceEventAudit).toHaveBeenCalledWith("member-1", "entry-1", "guild-1");
    const embed = select.update.mock.calls[0][0].embeds[0].toJSON();
    expect(embed.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Operational evidence", value: expect.stringContaining("UNKNOWN") }),
      expect.objectContaining({ name: "Ledger source reference", value: expect.stringContaining("not proof") }),
    ]));
  });
});
