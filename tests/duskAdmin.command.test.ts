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

function makeMaximumLengthEntry(index: number) {
  return makeEntry({
    id: `entry-${index}-${"e".repeat(90)}`,
    sourceEventType: `source-type-${"s".repeat(60)}`,
    sourceEventId: `source-${"i".repeat(100)}-${index}`,
    policyVersion: `policy-${"p".repeat(55)}`,
    reason: `verified qualifying work ${"reason-detail ".repeat(30)}`,
    actorDiscordUserId: `actor-${"a".repeat(70)}`,
    reversalOfId: `original-${"o".repeat(70)}`,
    reversals: [
      { id: `reversal-${"r".repeat(140)}-${index}` },
    ],
  });
}

function makeMaximumLengthReversal(index: number) {
  return {
    id: `request-${index}-${"q".repeat(90)}`,
    walletId: "member-1",
    originalEntryId: `entry-${index}-${"e".repeat(70)}`,
    requestedAmount: 10,
    sourceEventType: `source-type-${"s".repeat(55)}`,
    sourceEventId: `source-${"i".repeat(100)}-${index}`,
    idempotencyKey: `request-key-${index}`,
    attribution: null,
    policyVersion: `policy-${"p".repeat(55)}`,
    reason: `reversal reason ${"reason-detail ".repeat(30)}`,
    actorDiscordUserId: `requester-${"a".repeat(65)}`,
    createdAt: new Date("2026-11-12T20:00:00.000Z"),
    originalEntry: {
      id: `entry-${index}-${"e".repeat(70)}`,
      amount: 10,
      transactionType: "EARNING",
      reason: `original reason ${"original-detail ".repeat(30)}`,
      createdAt: new Date("2026-11-12T20:00:00.000Z"),
    },
    resolution: {
      id: `resolution-${index}`,
      resolutionType: "REJECTED",
      actorDiscordUserId: `reviewer-${"r".repeat(65)}`,
      reason: `review reason ${"review-detail ".repeat(30)}`,
      resolutionEntryId: `resolution-entry-${"x".repeat(70)}`,
      createdAt: new Date("2026-11-12T20:00:00.000Z"),
    },
  } as any;
}

function embedCharacterCount(embed: any): number {
  const data = embed.toJSON();
  return [
    data.title,
    data.description,
    data.footer?.text,
    data.author?.name,
    ...(data.fields ?? []).flatMap((field: { name: string; value: string }) => [field.name, field.value]),
  ].reduce((total: number, value: string | undefined) => total + (value?.length ?? 0), 0);
}

function expectEmbedWithinDiscordLimits(embed: any): void {
  const data = embed.toJSON();
  expect(embedCharacterCount(embed)).toBeLessThanOrEqual(6000);
  expect(data.fields?.every((field: { value: string }) => field.value.length <= 1024)).toBe(true);
}

function makeButtonComponent(interaction: any, customId: string) {
  return {
    customId,
    user: { id: "admin-1" },
    guildId: "guild-1",
    guild: interaction.guild,
    member: { roles: [] },
    memberPermissions: { has: vi.fn(() => true) },
    inGuild: () => true,
    isStringSelectMenu: () => false,
    isButton: () => true,
    reply: vi.fn(),
    update: vi.fn(),
    replied: false,
    deferred: false,
  };
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
      claimsTotal: 0,
      claimsSampleTruncated: false,
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

    expect(interaction.guild.members.fetch).toHaveBeenCalledWith({ user: "member-1", force: true });
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

  it("fails closed when a forced membership refresh no longer returns the selected member", async () => {
    const { interaction } = makeInteraction({ admin: true });
    interaction.guild.members.fetch.mockResolvedValue(null);

    await DuskAdmin.run({} as any, interaction, {} as any);

    expect(interaction.guild.members.fetch).toHaveBeenCalledWith({ user: "member-1", force: true });
    expect(duskLedgerService.getBalance).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("could not verify"),
        ephemeral: true,
      }),
    );
  });

  it("keeps the complete long claims field within Discord's field limit", async () => {
    const { interaction, handlers } = makeInteraction({ admin: true });
    await DuskAdmin.run({} as any, interaction, {} as any);
    const collect = handlers.get("collect");
    const claims = Array.from({ length: 100 }, (_, index) => ({
      id: `claim-${index}`,
      beneficiaryKey: `beneficiary-${"x".repeat(120)}-${index}`,
      walletId: index === 0 ? "member-1" : `other-wallet-${index}`,
      ledgerEntryId: `entry-${index}`,
      createdAt: new Date("2026-11-12T20:00:00.000Z"),
    }));
    vi.mocked(duskLedgerService.getSourceEventAudit).mockResolvedValue({
      entry: {
        id: "entry-1",
        walletId: "member-1",
        sourceEventType: "unknown-source",
        sourceEventId: "source-1",
        attribution: null,
      },
      sourceEvent: null,
      claims,
      claimRecordedForEntry: true,
      claimsTotal: 101,
      claimsSampleTruncated: true,
      policy: null,
      operationalEvidence: {
        status: "UNKNOWN",
        owner: null,
        summary: "No supported operational evidence owner is registered for this source type.",
        record: null,
      },
    });
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

    const embed = select.update.mock.calls[0][0].embeds[0].toJSON();
    expect(embed.fields.every((field: { value: string }) => field.value.length <= 1024)).toBe(true);
    const claimsField = embed.fields.find((field: { name: string }) => field.name === "Source-event claims");
    expect(claimsField?.value).toContain("Sample: 100 of 101 claim(s)");
    expect(claimsField?.value).toContain("not shown in this bounded sample");
  });

  it("bounds wallet, history, and reversal embeds with eight maximum-length rows", async () => {
    const entries = Array.from({ length: 8 }, (_, index) => makeMaximumLengthEntry(index));
    const reversals = Array.from({ length: 8 }, (_, index) => makeMaximumLengthReversal(index));
    vi.mocked(duskLedgerService.listAuditEntryPage).mockResolvedValue({
      entries,
      hasMore: false,
      nextCursor: null,
    });
    vi.mocked(duskLedgerService.listReversalRequests).mockResolvedValue(reversals);
    const { interaction, handlers } = makeInteraction({ admin: true });

    await DuskAdmin.run({} as any, interaction, {} as any);
    expectEmbedWithinDiscordLimits(interaction.editReply.mock.calls[0][0].embeds[0]);

    const collect = handlers.get("collect");
    const historyButton = makeButtonComponent(interaction, "dusk-admin:audit-interaction-1:history");
    await collect?.(historyButton);
    expectEmbedWithinDiscordLimits(historyButton.update.mock.calls[0][0].embeds[0]);

    const reversalButton = makeButtonComponent(interaction, "dusk-admin:audit-interaction-1:reversals");
    await collect?.(reversalButton);
    expectEmbedWithinDiscordLimits(reversalButton.update.mock.calls[0][0].embeds[0]);
  });
});
