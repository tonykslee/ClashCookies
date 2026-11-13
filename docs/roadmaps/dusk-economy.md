# Dusk Economy & Alliance Mobility — Living Roadmap

> **Status:** Planning / not implemented  
> **Last updated:** 2026-11-12  
> **Product:** ClashCookies / Dusk · Rising Dawn alliance  
> **Purpose:** Canonical, editable vision and decision log for the Duskits economy and voluntary alliance transfer pool.

## North star

Make Dusk more than an operations bot: a rewarding, welcoming part of alliance life. Recognize both strong Clash performance **and** the less-visible work that makes every clan successful. Give members a clear path to meaningful rewards, while making voluntary transfers easier for leaders and members.

**Member promise:** Be a dependable clanmate, help where you can, earn **Duskits**, and choose how to use them. Members who do not wish to switch clans should still have a fair path to progress.

### Product principles (committed direction)

1. **One hybrid economy:** Reward Clash achievements and alliance service; neither should dominate.
2. **Verified, not claimed:** Currency requires defensible persisted evidence. Never infer an action from an unrelated button, reaction, or missing record.
3. **Opt-in mobility:** Dusk suggests beneficial moves; it never coerces, kicks, auto-moves, or treats a surplus member as disposable.
4. **One person, one wallet:** Reward earnings consolidate across linked accounts to one Discord identity, with protections against multi-account farming.
5. **Accessible long-term rewards:** Aim for one personal +1 giveaway entry after roughly 1–2 months of dependable participation; create a special ~6-month path to sponsor a clan-wide +1.
6. **No disruption to operations:** Economy and transfer faults must not block war tracking, mail, reminders, compliance, or other essential bot behavior.
7. **Simple member UX:** Say “Duskits — alliance reward currency” on first exposure, with a welcoming “What the heck are Duskits?” explanation in the proposed `/dusk` hub.

## Product vocabulary

- **Duskit** (singular) / **Duskits** (plural): official fictional reward currency. Avoid switching between “points,” “credits,” and “coins” in member-facing copy.
- **Dusk Market:** proposed reward shop.
- **Dusk Wallet:** spendable balance + earnings/spending history.
- **Alliance Transfer Pool:** members volunteer eligibility/preferences for potential moves; leaders coordinate and approve beneficial moves.
- **Clan Sponsor:** proposed later expansion where one member funds a +1 entry for each eligible unique member of an eligible clan, subject to separate event and funding rules.

## Agreed vs proposed vs dependent decisions

| Topic | Status | Current direction |
| --- | --- | --- |
| Currency branding | **Agreed** | Duskits; plain-English explanation for new members |
| Economy identity | **Agreed** | Hybrid: Clash performance + alliance contribution |
| Transfer policy | **Agreed** | Voluntary only; no forced move, no reward simply for opting in |
| Personal giveaway time horizon | **Target** | Consistently good member earns entry in ~1–2 months |
| Clan sponsorship horizon | **Target** | ~6 months of sustained, eligible contribution |
| Personal entry price | **Proposal** | 100 Duskits; validate earning data first |
| Routine earn-rate target | **Proposal** | ~15–20 Duskits/week; routine weekly cap 30 |
| Clan-wide sponsorship price | **Proposal** | 500 Duskits **plus** eligibility milestone; price/scale requires review |
| Transfer reward | **Proposal** | +20 verified transfer; +10 after 14 days in destination |
| +1 giveaway inclusion | **Explicitly endorsed (user-confirmed)** | Elle has given permission **and advocacy** for including +1 giveaway rewards in Dusk. No need to re-request general approval of the concept; this is not permission for automated fulfillment or unlimited entries |
| First giveaway delivery scope | **Agreed direction** | Personal +1 first using Discord roles: +1 roles persist across giveaways and **Elle removes all of a winner's +1 roles when they win**. Sponsorship stays deferred to M6 |
| Personal +1 stacking | **Agreed** | The three existing +1 roles continue stacking as they do today. The **separate Duskits +1** stacks on top of them, so a member holding all three existing roles may still buy Duskits +1 (four +1 roles total). No shared three-role purchase cap applies to Duskits |
| Dusk purchase role mapping | **Agreed** | Add **one distinct Duskits-owned +1 Discord role**, not any of the three existing roles. Dusk only sells/grants its own role and does not assign or modify roles earned through other avenues |
| Dusk purchase quantity | **Agreed** | Maximum **one active Duskits +1 role per Discord member**. While held it cannot be purchased again; after Elle consumes/removes it for a win, the member can rebuy with sufficient Duskits. No cooldown or lifetime ban |
| Dusk +1 repurchase after a win | **Agreed** | After a member wins and their previous Dusk +1 is consumed/removed, they may buy a new Dusk +1 **whenever they have sufficient Duskits**. No permanent one-time-purchase restriction or post-win cooldown was requested |
| Concrete command and DB names | **Design draft** | Confirm in implementation PRs, not fixed APIs yet |

**Important:** Elle's permission and advocacy for Dusk +1 giveaways are confirmed by the project owner. The user has clarified that the current giveaway-entry mechanism is based on **Discord roles**, not a separately maintained Rising Maple entry registry. Do not require a Rising Maple API or manual third-party entry registration as a default prerequisite. The **new dedicated Duskits role ID**, its giveaway-count configuration, winner-removal process, concurrent-purchase safeguards and cancellation/refund policy remain to be defined; **one active Duskits +1 that stacks independently of all existing +1 roles, and winner-consumption by Elle are user-confirmed**; no automatic redemption or clan sponsorship is authorized by this design note.

## Reward design — starting calibration, NOT live policy

| Evidence-backed action | Draft Duskits | Guardrail |
| --- | ---: | --- |
| 3-star attack in verified Blacklist war | +5 | At most once per Discord user per eligible war; verify actual attack evidence |
| Clean FWA war participation | +4 | Ended canonical FWA war, qualifying participation **and completed** compliance evaluation with no relevant violation; missing evaluation ≠ clean |
| Base-swap acknowledgment | +2 | Once per eligible war/user; rewards acknowledgment only, not verified layout change |
| Attributable FWA rep action | +2 | Use existing deduplicated rep-work events; bounded rate and per-user cap |
| Active rep weekly stipend | +4 | Only after a defined threshold of verified work; no passive title-only income |
| Paid weekly quest | +8 | One paid quest per member per week in initial design; prevent duplicate underlying claims |
| Beneficial transfer confirmed | +20 | Member consent, leader approval, actual roster move, anti-farming cooldown |
| Continued destination membership | +10 | Verified after 14 days and qualifying transfer remains valid |

Routine categories share a **proposed cap of 30 per Discord user per week**; special transfer rewards are separately limited (initial idea: at most one rewarded transfer per user per 30 days). Caps, reward values and valid evidence need simulation before activation.

**Quality bar:** Do not pay for zero violations without proven qualifying participation; do not pay early base swap bonuses until an actual timely base change can be proven; do not misinterpret a completed reaction as proof of an in-game action. Do not reward repeated action spam, improper attacks, filler manipulation or cycling accounts between clans.

### Economy targets and sustainability

- **100 Duskits / personal +1 (proposal):** this buys a role entitlement that **persists until its holder wins a giveaway** (then Elle removes all their +1 roles), not merely a ticket for one drawing. That longer lifetime materially affects the value and makes pricing provisional. ~15–20 Duskits/week would reach 100 in ~5–7 weeks, but the eight-week rep-work simulation did **not** establish that pace for typical members; do not inflate earn rates to compensate for limited observed participation.
- **500 Duskits + ~6-month eligibility / clan-wide +1:** exceptional recognition, not ordinary bulk pricing. One sponsor may grant an extra entry to each *eligible unique Discord participant*, not each CoC account. Eligibility and giveaway caps must be checked at redemption.
- The clan-wide price is deliberately discounted relative to buying dozens of individual entries; this requires explicit organizer approval and an alliance-wide issuance budget.
- No Duskits-for-real-money purchase, cash-out, player-to-player currency transfers, or gambling mechanics in the initial design.
- Members should not be required to triple, be a rep, or accept a transfer to achieve ordinary personal progress.

### M0b giveaway governance — personal-first, dedicated Discord role

**Agreed / user-confirmed product policy (2026-11-12):**
- Elle permits and advocates a Dusk-funded +1 giveaway reward. Start with the **personal +1** proof of concept; defer clan-wide sponsorship to M6.
- Create a **separate Duskits +1 giveaway Discord role**. Dusk may grant only that role; it does **not** assign, remove, consume or repurpose the existing three +1 roles earned through other avenues.
- The Duskits +1 **stacks independently** with the existing roles. Even if a member holds all three existing +1 roles, they may buy a Duskits +1, for a total of **four** additional entries from those four +1 roles. There is **no cross-source three-role cap** on a Duskits purchase.
- Each Discord member may hold **at most one active Duskits +1 role**. They cannot purchase another while holding it, even if they have enough Duskits. Linked CoC accounts do not multiply entitlements.
- +1 roles persist between drawings until their holder wins. On a win, **Elle manually removes all the winner's +1 roles**, including the Duskits role once configured. The winner may buy another Duskits +1 later **whenever they have sufficient Duskits**, with no lifetime restriction or post-win cooldown.
- Giveaway participation is represented through Discord roles. A Rising Maple API or separate manual entry registry is **not required by the agreed concept**; the giveaway organizer must ensure the new Duskits role actually counts as +1 and is included in winner cleanup.

**Proposed implementation controls — not approval to deploy:**
- Configure one stable Discord role ID in the giveaway guild for the **Duskits-owned +1** and verify its effective entry weight, stacking and role hierarchy before opening sales. Ignore the other +1 roles when determining whether someone may buy Duskits +1; check only the Duskits role and economy prerequisites.
- Enforce **one outstanding/active Duskits entitlement per Discord identity** in durable redemption state, with a unique source/transaction identity. Check current Discord role membership before charging or granting; repeated clicks, retries and concurrent purchases must not double-charge, issue duplicate entitlements or bypass the one-role limit.
- The ledger and Discord role grant are **not atomic**. Use a reservation/fulfillment/reconciliation path: commit the charge only for a confirmed grant, and handle uncertain Discord results via retries or review rather than guessing. Active runtime only; mirror must not issue Duskits, charge wallets or modify roles.
- A **verified winner/consumption event** permits a fresh paid purchase. A missing role by itself is not proof of winning; do not silently regrant one removed after a win. A properly consumed role is **not refundable** merely because its holder won.
- The proposed **100-Duskit price** remains provisional for **one Duskits +1 role**, whose effect persists until a win. Unfulfilled purchases, permission failures, unexplained role loss, giveaway cancellation and other non-win failures require explicit refund/reversal rules before launch.
- Document member-facing price, eligibility, one-active-Duskits-role limit, independent stacking, winner-consumption, rebuy and non-win refund rules.

**Still open before M0b completion:** Create/configure the specific Discord role and record its ID; ensure the giveaway counts it separately and Elle removes it upon a win; define reliable winner/consumption confirmation, initial purchase eligibility, final price and refund/failure terms. **The shared-three-role slot mapping and multi-purchase plan from PRs #1969–#1970 are superseded by the dedicated one-role decision.** No code, live role change, currency issuance or launch has been authorized.

**M6 extensibility:** Future clan-wide sponsorship is a **separate** Dusk Market reward with its own eligibility, recipients, funding and safeguards; do not introduce bulk grants or clan treasuries into the personal proof of concept.

### Separate the three scoreboards

1. **Wallet balance:** spendable Duskits, including purchases/refunds.
2. **Lifetime earned:** earned Duskits independent of spending, for contribution rankings.
3. **Game/contribution statistics:** actual wars, triples, activity, rep service and verified transfers, independent of economy prices and caps.

## Alliance Transfer Pool — product shape

- Member can opt into consideration and set preferences: open to offers / ask first / prefer staying; optional temporary vs permanent moves.
- Dusk reads persisted ACTUAL roster/weight evidence and HeatMapRef projection to suggest exchanges, one-way vacancy fills and eventually multi-clan rotations. Always re-evaluate **total weight, selected reference band, resulting deviation, vacancy and actual weights** for the full proposed move, not just a single bucket delta.
- Paired transfer campaigns may publish coordinated posts in each clan's chosen announcement channel with a deadline, targeted weight range/buckets, number needed, volunteers and remaining need.
- Allow more volunteers than required (waitlist). Distinguish **volunteered → matched → awaiting actual move → verified → completed**, plus withdrawn/expired/cancelled.
- One side awaiting volunteers should be **pending**, not shown as a completed swap. Partial completions should remain visible. One-way placements do not require a reciprocal volunteer.
- Destination clan link should be provided; member and leaders must explicitly approve a proposed placement. No automatic kicks/invites presented as guaranteed outcomes.
- Verify actual clan membership through the owning roster state before completing a move or issuing Duskits; handle stale/unknown evidence without guessing.
- Respect existing Home Clan periods, temporary Away status, return reminders and home-transfer review flow; mobility must not silently reassign Home.

## Architecture fit and observability

Use existing domain owners as **evidence only**, without writing currency into operational tables:

| Evidence / system | Existing owner or service |
| --- | --- |
| Ended war participation and summary | `ClanWarHistory`, `ClanWarParticipation` |
| Detailed archived war evidence | `WarLookup` |
| War-plan compliance | `WarPlanComplianceEvaluation`, `WarPlanViolation` |
| Rep-work attribution | `RepWorkActivityEvent` / `RepWorkActivityService` |
| Base-swap acknowledgment | `TrackedMessage` and existing FWA swap logic |
| Player identity | `PlayerLink` (honor verification/trust state) |
| Composition | `CompoActualStateService`, `CompoPlaceService`, `CompoReplacementService` |
| Home/membership facts | `ClanHomeMembershipService`, `SyncClanMemberSnapshot`, other canonical membership owners |

**New durable owners (to design in first implementation PR):** independent economy transaction ledger, reward policy configuration/version, redemption/fulfillment state, and transfer opt-in/campaign/match state. A balance may be computed from the ledger or maintained as an **atomic derived projection**, never as an independent competing source of truth. Enforce unique source-event reward identity; use compensating reversal transactions, not destructive edits. Store immutable award-rate version/evidence and attributed Discord user, making audits and corrections possible if a source event changes. Model redemption reservations/fulfillment/refunds transactionally to prevent double-spends and negative wallets.

**Runtime:** active production owns reward reconciliation and delivery; mirror mode must never issue currency or send prize fulfillments. Use bounded, DB-first batch readers. Economy failures are isolated and retriable, not coupled to source write success. No retroactive automatic payouts at launch.

**Observability:** log/measure eligible, awarded, skipped (with reason codes), duplicate, pending, reversed, reconciled, and failed reward events; pending/fulfilled/refunded purchases; transfer matching/move verification; daily issuance, weekly per-user distribution and outstanding redemption liability. Avoid exposing personal account data in public feeds. See [architecture contract](../architecture-contract.md), [priorities](../core-priorities.md), [project brain](../project-brain.md), and [observability](../observability.md).

## Milestone roadmap (order is a proposal, not a calendar commitment)

| Milestone | Priority | Status | Outcome / exit criterion |
| --- | --- | --- | --- |
| **M0 — Policy and evidence audit** | P0 | In progress — M0a complete; M0b dedicated Duskits role policy settled, configuration/terms pending | Evidence audit and SELECT-only simulation reviewed. Elle endorses +1 giveaways. Dedicated Duskits +1 stacks with existing roles but permits only one active Duskits role, consumed on a win; rebuy allowed after consumption. Role ID, price, initial eligibility and non-win remedies remain open; clean-FWA UNKNOWN and no issuance approved |
| **M1 — Ledger and Dusk hub** | P0 | Not started | Transaction-safe wallet/ledger, idempotency, admin audit/adjust/reverse, read-only `/dusk` balance/history, tests/docs/permission coverage; no payout rules yet |
| **M2 — Verified earning engine** | P0 | Not started | Start with a small set of reliable signals; per-user limits, no duplicate payouts, replay/recovery and manual reconciliation; expand BL/clean-war only after eligibility proof |
| **M3 — Personal Market redemption** | P1 | Not started | Personal +1 proof of concept: grant one dedicated Duskits +1 role, independent of the three pre-existing roles; enforce one active Duskits entitlement per Discord member, idempotent ledger/role grant, winner-consumption cycles and reconciliation. No live role grant until approved |
| **M4 — Alliance Transfer Pool** | P1 | Not started | Opt-in/preferences, read-only opportunities, optional coordinated campaigns, verified completions, Home-safe updates; transfer rewards only after evidence |
| **M5 — Engagement & recognition** | P2 | Not started | Weekly quests, profiles, configurable per-clan/alliance rankings, achievements; raw Clash stats separated from earned Duskits |
| **M6 — Clan Sponsor / treasury** | P2 | Deferred | Extend verified role-entitlement fulfillment to multiple eligible unique members only after the personal flow works and sponsorship price, service rule, organizer budget, entry limits and authorization are confirmed. Pooled treasury optional |

### Implementation slices — scoped PRs, not one giant change

- [x] M0a part 1: Document eligibility/evidence sources, query designs and hard UNKNOWN states. See [Dusk reward evidence diagnostic](../diagnostics/dusk-reward-evidence.md). No database sample or reward issuance was performed.
- [x] M0a part 2: Ran and reviewed a real eight-week, one-guild SELECT-only historical earnings simulation and a post-fix rerun against the same fixed scope. The corrected classifier eliminated 5,900 war-end-only identity conflicts without issuing or recognizing any clean-FWA rewards: all 199 rosters remain unproven. Recognized FWA rep work and draft calibration are documented in the [historical earnings simulation diagnostic](../diagnostics/dusk-historical-earnings-simulation.md). This closes the **simulation/review task only**, not reward eligibility, rate approval, or issuance.
- [ ] M0b: Elle's endorsement, personal-first delivery, **one dedicated Duskits +1 role independently stacking with the three existing roles**, one active Duskits role per Discord member, winner-consumption and funded post-win repurchase are agreed. Configure/verify the new role ID, entry counting and Elle's winner cleanup; settle consumption proof, launch eligibility, price, non-win refunds and member-facing terms. Earlier shared-slot/multi-purchase design superseded; M6 sponsorship deferred. **M0b not complete**.
- [ ] M1a: Ledger transaction + policy schema, safe migration and ownership boundaries (no commands).
- [ ] M1b: Wallet/query/admin adjustments, permissions, help, tests and readme.
- [ ] M2a: One reliable reward source end-to-end including active-only reconciler, dedupe, observability and rollback/reversal tests.
- [ ] M2b: Add other verified sources and caps only after audits.
- [ ] M3–M6: Split each milestone into small service/persistence, commands/UI and verification/reliability PRs after preceding scope is reviewed.

**Mandatory release gates:** no architecture ownership conflicts, no accidental reward issuance in staging, deterministic repeated-event handling, no negative wallet or double redemption, no regression to existing war/mail/sync/reminder flows, migration safety, documented permission targets, robust tests, production metrics and a rollback/disable switch.

## Open questions / decisions to make before launch

- [ ] **Discord role fulfillment boundaries:** Confirm creation/ID and giveaway counting of the **new dedicated Duskits +1 role**, inclusion in Elle's winner cleanup, winner-consumption proof, eligibility, the **one-active-Duskits-role** restriction, idempotent purchase/role-grant behavior, non-win refunds and Discord permissions. Existing roles are not part of the purchase cap. Sponsorship deferred.
- [ ] **Existing bonus-role coexistence:** The original three +1 roles continue to stack and are **untouched by Dusk**. A member may hold all three plus **one Duskits +1** (four total). Confirm the giveaway counts the new role as an independent entry and Elle's winner-removal workflow covers it. No Rising Maple API requirement.
- [ ] **Entry eligibility / promotional terms:** Confirm launch eligibility and giveaway-rule constraints. A member with any number (0–3) of existing +1 roles may buy **one Duskits +1** if they do not currently hold it and have sufficient funds. After a verified win and consumption, repurchase is allowed without a lifetime ban or cooldown. Do giveaway rules require a free alternative or other constraints?
- [ ] **Coin budget:** Calibrate real earning distributions, multi-account effect, personal entry price and clan sponsor liability using observed data.
- [ ] **Reliable war scoring:** Which completed BL/attack evidence proves a triple? What counts as qualifying clean FWA participation? How do corrections/re-evaluations reverse payouts?
- [ ] **Rep stipend:** Define verified weekly minimum, rate, idempotent period, and overlap with per-action earnings.
- [ ] **Quests:** Which are achievable by casual members without forcing moving clans or improper gameplay?
- [ ] **Transfer eligibility:** How are 14-day residence, temporary transfers, Home changes, stale membership and per-user cooldowns handled?
- [ ] **Clan sponsor (M6, not personal PoC):** Define six months of good service (e.g. qualifying active weeks, not an unbroken perfect streak), sponsor price, eligible recipients, per-event/clan limits, funding and affordability only after the personal flow is proven.
- [ ] **Launch mechanics:** Enablement flag, no back-pay, announcement/onboarding copy, economy admin permissions and support playbook.

## How to maintain this document

This is the **vision/roadmap source of truth**, not an implementation spec or authorization to deploy incentives.

1. When we settle a decision, move it from “proposed/open” to “agreed,” recording the reason and date in the log below.
2. When a PR starts or merges, update its milestone status, scope, blockers, any changed assumptions, and the relevant unchecked task. Never mark shipped based on a plan alone.
3. Keep documented product promises distinct from unverified suggestions. Changes affecting architecture must also update the canonical architecture/project-brain docs in the implementing PR.
4. Keep implementation work in small, reviewable feature-branch PRs. Follow `scripts/start-feature.sh`, `docs/core-priorities.md`, tests, help and command coverage requirements.
5. At each checkpoint, reassess **member fairness, currency issuance, sponsor liabilities and member experience**. Do not sacrifice clan relationships or operational reliability for engagement metrics.

### Decision log

| Date | Decision / discussion | State |
| --- | --- | --- |
| 2026-11-12 | Name currency **Duskits**, plural; explain clearly on first use | Agreed |
| 2026-11-12 | Hybrid reward model: performance + service; voluntary transfer pool | Agreed direction |
| 2026-11-12 | Aim for personal +1 after ~1–2 months, clan-wide sponsor after ~6 months | Targets, pricing/terms provisional |
| 2026-11-12 | Project owner reconfirmed Elle's **permission and advocacy** for +1 giveaways in Dusk; general concept approval is settled, while specific event funding, fulfillment, limits and automation remain undecided | Explicit endorsement confirmed (user-reported); operational terms open |
| 2026-11-12 | Prioritize a **personal +1 proof of concept** using Discord roles; later confirmation establishes that +1 roles persist across giveaways until a win. Keep extensible for future clan sponsors without bulk funding or treasury now | Agreed direction; win-consumed lifetime confirmed; sponsorship deferred to M6 |
| 2026-11-12 | User provided screenshot showing separately earned `+1 [Giveaway Entry]` Discord roles (three visually distinct punctuation variants), Clan Games multiplier roles, and a `+3 Sponsored Clan` role. Giveaway participation is role-defined, not an external Rising Maple fulfillment process; exact role IDs were not provided, while role stacking was subsequently confirmed by the project owner | Observed role surface; later stacking confirmation recorded separately; no integration requirement |
| 2026-11-12 | Project owner clarified **Elle manually removes all +1 giveaway roles when a member wins**; otherwise they persist between giveaways. A Dusk +1 should therefore be win-consumed, not reset every drawing. Need confirmed winner-consumption provenance before any new purchase; role disappearance alone does not establish a win | Agreed/user-reported giveaway rule; consumption evidence mechanism open |
| 2026-11-12 | After winning, members **may purchase another Dusk-funded +1** as soon as they have enough Duskits and their previously purchased Duskits role was consumed; each purchase starts a new win-consumed entitlement. No permanent one-purchase limit or post-win cooldown | Agreed; must prevent duplicate active Duskits grants and prove prior win |
| 2026-11-12 | Earlier discussion established that the **three existing +1 roles stack** and initially proposed buying available slots among those three | **Superseded** for Dusk purchases by later dedicated-role decision; existing three roles still stack |
| 2026-11-12 | Earlier design allowed purchasing any missing existing +1 role, potentially all three with funds | **Superseded** by dedicated Duskits role with one active purchase | 
| 2026-11-12 | Project owner selected a **separate Duskits +1 role** which stacks with all three existing +1s (allowing four total) and cannot be bought again **while active**. On a win Elle consumes/removes it with the other roles, after which it may be purchased again if funded | **Agreed** final personal-role policy for M0b; role ID, price and launch mechanics pending |
| 2026-11-12 | M0a part 1 repository evidence audit completed: FWA rep-work is strongest, clean FWA participation conditional, BL/base-swap/transfers require stronger proof; no production sample run | Evidence diagnostic complete; simulation pending |
| 2026-11-12 | Prepared a manual bounded read-only M0a part 2 simulator with strict/provisional/UNKNOWN reporting, source deduplication, weekly cap analysis and deterministic fixture tests; no historical database sample was run | Implementation prepared; M0a part 2 remains incomplete |
| 2026-11-12 | First eight-week SELECT-only sample executed twice with a fixed snapshot: 199 ended wars, 9,950 participation rows, and 5,900 end-time-only identity conflicts; all production rosters remained UNKNOWN | Initial provenance diagnosis; subsequently addressed by PR #1962 |
| 2026-11-12 | M0a part 2 reviewed after merged PR #1962 and a bounded post-fix rerun: no remaining war-identity conflicts; all 199 rosters still UNKNOWN; 589 recognized rep actions, 1,178 uncapped / 992 capped draft Duskits, 16 observed earning users, and one projected to reach 100 in seven weeks at the observed rate | Simulation milestone complete; +2/action, 30/week, and 100-entry target stay provisional; clean-FWA and other unproven evidence must not earn; no payout/backpay authorized |

### Success measures (initial)

- Share of **eligible active Discord members** earning Duskits in a four-week period, segmented by single-account/multi-account and rep/non-rep.
- Distribution of time to first personal reward for reliable members (target ~4–8 weeks, without required competitive triples).
- Duplicate reward/reversal incidents, unfulfilled redemptions and wallet reconciliation discrepancies (target zero unresolved).
- Verified *voluntary* beneficial transfers, sustained 14-day stays, and net before/after composition improvement; also monitor member withdrawals.
- User comprehension: members understand “Duskits” and where to find earnings/market without a staff explanation.

**Next action:** Create/configure and verify the **single dedicated Duskits +1 role ID**, entry counting and inclusion in Elle's winner cleanup; then settle consumption evidence, launch eligibility, provisional **one-role price**, non-win refunds and member-facing terms. **One active Duskits +1 independent of existing roles, with funded post-win repurchase, is agreed.** Then scope M1a's separate wallet/ledger ownership; no Rising Maple API or manual external fulfillment is assumed. Treat sponsorship as an M6 follow-on rather than a personal proof-of-concept dependency. Do not treat the completed simulation as approval for rates, clean-FWA eligibility, retroactive rewards, production deployment, or issuance. **No code or reward issuance is authorized by this roadmap alone.**
