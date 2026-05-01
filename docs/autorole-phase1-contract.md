# Autorole Phase 1 Contract

This document locks the first autorole product contract for ClashCookies. It is design-only: no schema, commands, schedulers, or Discord write paths are defined here yet.

## Goal

Deliver ClashPerk-style autorole parity for the core role families ClashCookies already understands, while keeping the system deterministic, auditable, and safe to roll out gradually.

## In scope

Phase 1 must support:

- verified account ownership
- family/member role assignment
- clan-specific roles
- clan-rank roles: `member`, `elder`, `coLeader`, `leader`
- Town Hall roles
- nickname sync
- manual sync
- scheduled/background sync
- audit logging
- exclusions and ignore rules

## Out of scope

Phase 1 explicitly does not include:

- `eos-push`
- any new parallel identity/link system
- live API lookups on the hot sync path when persisted data already exists
- unmanaged role cleanup
- any optional parity features deferred to later phases

## Terminology

- **Linked account**: a `PlayerLink` row tied to a Discord user.
- **Trusted link**: any persisted link the system is allowed to use for autorole evaluation.
- **Verified link**: a link proven by token verification and eligible for the Verified rule.
- **Managed role**: a Discord role explicitly owned by autorole config.
- **Desired state**: the roles and nickname autorole wants a member to have after evaluation.
- **Preview**: a read-only evaluation that reports intended actions without writing to Discord.

## Trust model

### Default policy

Phase 1 defaults to **trusted links allowed**. Token-verified links, admin-created links, and imported links may all drive autorole decisions unless a guild explicitly opts into stricter verified-only handling later.

### Ownership levels

- **Token-verified links** may satisfy every v1 rule type.
- **Admin-created links** and **imported links** are trusted for operational autorole rules, but they do not count as proof of ownership for the Verified rule.
- **Verified-only enforcement** is not the default. If a guild enables it later, it applies only to the rule types that require proof of ownership.

### Rule-type ownership requirements

- **VERIFIED**: requires a token-verified link.
- **FAMILY**: any trusted link may qualify.
- **CLAN**: any trusted link may qualify.
- **CLAN_ROLE**: any trusted link may qualify.
- **TOWN_HALL**: any trusted link may qualify.
- **LABEL**: reserved for later phases.

## Aggregation rules

One Discord user may have multiple linked player tags. Autorole must evaluate all linked accounts and then collapse them into one deterministic desired state per guild.

### Core rules

- Evaluate every linked account independently.
- Within a rule family, only the highest matching result applies.
- Across different rule families, roles may stack if they are distinct managed roles.
- One user may hold multiple clan roles simultaneously when those roles come from different managed clan configurations.
- Never grant the same managed role twice even if multiple linked accounts match it.

### Precedence

When multiple linked accounts could drive the same family, use this precedence:

1. token-verified links
2. admin-created links
3. imported links
4. newest trusted link timestamp
5. lowest normalized player tag as a final deterministic tie-breaker

### Specific family precedence

- **Highest Town Hall role**: pick the highest TH tier across all linked accounts.
- **Highest clan-rank role**: within one clan-role ladder, use `leader > coLeader > elder > member`.
- **Family/member role**: grant once if any trusted link qualifies.
- **Clan membership role**: grant once per configured clan role target that any eligible linked account satisfies.
- **Nickname source account**: choose the single top-ranked linked account after the same precedence ladder, then use that account for nickname variables.

## Managed role ownership

Autorole may only add/remove roles that are explicitly declared in the guild's autorole configuration.

### Hard ownership rules

- Never remove unmanaged roles.
- Never infer ownership from role name alone.
- Never mutate Discord roles that are not in the managed set.

### Stale-role removal

- If removal is enabled for the guild, autorole removes managed roles that no longer match on the next sync.
- If removal is disabled, autorole keeps stale managed roles and only adds or refreshes roles.
- Stale managed roles are removed immediately when a live sync runs and removal is enabled.

### Removal policy

Guilds must opt in to removals before autorole may delete managed roles. That keeps the Phase 1 launch safe and previewable.

## Rule model

Phase 1 supports a small, explicit rule set. Each rule resolves from persisted state only.

| Rule type | Source fact | Matching behavior | Stack behavior | Highest-wins? |
| --- | --- | --- | --- | --- |
| VERIFIED | Link verification state | Match when the user has a token-verified link | No | Yes |
| FAMILY | Trusted link existence | Match when the user has at least one trusted linked account | No | Yes |
| CLAN | Current clan membership | Match when a linked account belongs to the configured clan | Yes across different clans | Yes within one clan role |
| CLAN_ROLE | Current clan rank | Match on clan rank from persisted current clan data | Yes across different clans | Yes, `leader > coLeader > elder > member` |
| TOWN_HALL | Current Town Hall | Match on persisted Town Hall value | No | Yes |
| LABEL | Manual label / tag rule | Reserved for later phases | TBD later | TBD later |

### Matching source facts

- Clan membership and clan rank come from persisted current-state tables, not live API lookups on the sync path.
- Town Hall comes from persisted current-state tables.
- Verified ownership comes from the link record itself.

## Nickname sync contract

- Nickname sync is optional per guild.
- Nickname sync may use a template, but Phase 1 keeps the template vocabulary small and explicit.

### Allowed template inputs

- player name
- Town Hall
- clan short name
- clan name
- optionally the Discord display name as a fallback token

### Source account

Use the same top-ranked linked account chosen by the aggregation precedence rules. That keeps nickname selection deterministic and aligned with the role evaluator.

### Failure behavior

- If the bot lacks nickname permissions, role sync still proceeds.
- Nickname failures are audit logged and surfaced in preview/output.
- Nickname sync must never block role sync completion.

## Sync triggers

Phase 1 supports these triggers:

- user links an account
- user unlinks an account
- user verifies an account
- member joins the guild
- admin runs a manual sync
- scheduled reconciliation

### Phase 1 vs later

- All triggers above are in Phase 1.
- Any additional trigger source, webhook, or external event bridge is later-phase only.

## Exclusions and safeguards

### User-level exclusions

- A guild may exclude specific Discord user IDs from autorole evaluation.
- Excluded users are never written to and are omitted from previews unless the preview explicitly asks for excluded-state inspection.

### Role-level exclusions

- A guild may exclude members who already hold one or more configured Discord roles.
- Exclusions are evaluated before any write plan is built.

### Guild kill switch

- A guild-level kill switch disables live autorole writes and scheduled reconciliation.
- When the kill switch is on, preview is still allowed, but no Discord state may change.

### Dry-run / preview

- Preview must be available before any broad rollout.
- Preview shows intended adds, removals, nickname changes, skipped items, and reasons.
- Preview is the authoritative safety check before enabling live sync.

## Rollout assumptions

- Phase 1 launches disabled by default for new guilds.
- Guilds should preview first, then explicitly enable live sync.
- Add-only or add-first rollout is acceptable until removal is explicitly enabled.
- Managed-role removal remains opt-in until guild operators have validated previews.

## Operator UX direction

The intended command surface for later phases is:

- `/autorole config`
- `/autorole rules`
- `/autorole preview`
- `/autorole sync`
- `/autorole show`

These names are intentionally reserved now to reduce future drift.

## Open questions resolved

- **Default trust mode**: trusted links allowed.
- **Verified ownership**: required only for the Verified rule, and for any future verified-only guild mode.
- **Multiple linked accounts**: evaluate all of them, then collapse to one deterministic desired state.
- **Multiple clan roles**: allowed when they come from different managed clan configs.
- **Unmanaged roles**: never touched.
- **Removal policy**: opt-in, previewable, and guild controlled.
- **Nickname source**: use the same precedence ladder as role evaluation.
- **`eos-push`**: explicitly out of scope for Phase 1.

## Non-negotiables

Future phases must preserve these invariants:

- pure evaluator first, Discord writes later
- no unmanaged role removals
- deterministic multi-account precedence
- preview before broad enforcement
- auditability for every sync action
