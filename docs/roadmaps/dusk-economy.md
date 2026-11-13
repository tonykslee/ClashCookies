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
| Personal +1 stacking and cap | **Agreed** | The three existing distinct +1 roles stack: each held role gives +1. A member holding all **three** cannot buy another personal +1 with Duskits; available capacity is shared across acquisition avenues. A clan-wide +1 purchase is a separately scoped future shop item |
| Dusk purchase role mapping | **Unresolved design** | Dusk must use an organizer-approved way to award an **unoccupied personal +1 slot** within the existing three-role cap while preserving the reward source in its own records. Do **not** introduce a fourth counting role by default or overwrite an existing award |
| Dusk +1 repurchase after a win | **Agreed** | After a member wins and their previous Dusk +1 is consumed/removed, they may buy a new Dusk +1 **whenever they have sufficient Duskits**. No permanent one-time-purchase restriction or post-win cooldown was requested |
| Concrete command and DB names | **Design draft** | Confirm in implementation PRs, not fixed APIs yet |

**Important:** Elle's permission and advocacy for Dusk +1 giveaways are confirmed by the project owner. The user has clarified that the current giveaway-entry mechanism is based on **Discord roles**, not a separately maintained Rising Maple entry registry. Do not require a Rising Maple API or manual third-party entry registration as a default prerequisite. Role IDs, Dusk-to-available-slot mapping and cancellation/refund policy remain to be defined; **stacking, the maximum three concurrent personal +1 roles, and winner-consumption by Elle are user-confirmed**; no automatic redemption or clan sponsorship is authorized by this design note.

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

### M0b giveaway governance — personal-first, Discord-role-based proof of concept

**Agreed or user-described behavior (2026-11-12):**
- Elle permits and advocates Dusk-funded +1 giveaway rewards; prioritize a **personal +1** proof of concept and defer clan sponsorship to M6.
- The current giveaway uses **Discord roles** to represent extra-entry entitlements; the user showed `x1 [Clan Games]`, `x2 [Clan Games]`, `x3 [Clan Games]`, **three distinct `+1 [Giveaway Entry]` roles** differentiated by punctuation and earned through different avenues, and `+3 Sponsored Clan`. The project owner explicitly confirmed that **the three personal +1 roles stack**, each granting its own +1, and that **holding all three blocks another personal +1 purchase**. The +1 roles carry forward across giveaways until the member wins; Elle then removes all the winner's +1 roles. This is not a per-giveaway reset.
- One Discord identity has one Dusk Wallet, regardless of linked CoC accounts. No separate Rising Maple API, organizer-maintained ledger, or manual registration is necessary **if** the giveaway actually counts the configured Discord roles.
- **After winning, a member can buy another Dusk-funded +1 if they have enough Duskits and have an unoccupied personal +1 slot.** The previous +1 is consumed when Elle removes winner roles; the next purchase is a fresh entitlement, not a free reinstatement. No lifetime one-purchase cap or automatic post-win cooldown is part of this agreed direction.
- **Personal acquisition ceiling:** Up to three concurrent stacking +1 roles, shared across all avenues. Dusk must refuse a personal purchase when all three are held and must not debit the wallet. A future **clan-wide** sponsorship is a distinct M6 shop reward, not an exception silently added to the personal +1 limit.

**Proposed implementation boundaries (not approved to deploy):**
- Do **not** add a fourth counting personal +1 role as the default Dusk implementation. Define a confirmed, stable-ID mapping that awards an **unoccupied slot among the three existing roles**, subject to the organizer's agreement and existing role ownership. Preserve **award provenance** in Dusk's redemption ledger: an existing role may have been earned elsewhere, and Dusk must not charge for, overwrite, revoke, or claim ownership of that unrelated award. If the existing roles cannot safely be used this way, return to M0b for a role-mapping decision rather than inventing a new slot.
- On an eligible member redemption, validate the Discord identity, wallet balance, **all three role IDs**, remaining personal +1 capacity, current price/policy, award provenance, and Dusk's `Manage Roles`/hierarchy access. **Fail closed** when all three roles are held, membership cannot be verified, or no safe unoccupied slot can be assigned; do not debit Duskits. Model purchases as **win-consumed entitlements** rather than per-draw tickets. Prevent duplicate grants/charges to the **same role slot or outstanding purchase**. After Elle removes the member's roles following a **verified win**, they may buy a new role with sufficient Duskits; no lifetime ban or post-win cooldown, and mere role absence does not establish a win.
- The ledger and Discord role assignment are **not one atomic transaction**. Reserve/spend through the economy owner, attempt the role grant, confirm recorded fulfillment only on a verified successful grant, and retry/reconcile/refund when Discord operations fail or are ambiguous. Repeated requests must not double-spend or add a duplicate entitlement to an already occupied role slot; concurrent requests must enforce the three-role cap against authoritative role state. Treat **confirmed winner consumption** separately from unexplained/manual role loss: do not silently regrant a role Elle removed on a win, and do not infer a win from role absence alone. Active runtime only; mirror does not mutate roles or charge wallets.
- Keep the draft 100-Duskit price and purchase limits provisional: a +1 held until a win has **recurring drawing value**, unlike a single-draw entry, so reassess price and liability with the actual terms. **A win consumes the role; that is normal reward use, not a refund event.** Unexplained removal, bot errors, rule changes and giveaway cancellation need separate approved remedies; do not automatically refund or reinstate a winner's consumed entitlement.
- Publish member-facing price, eligibility, duration, availability, quantity/stacking rules, and refund/cancellation terms before redemption opens. Organizer oversight can validate entry-count configuration without requiring manual fulfillment of each purchase.

**Open questions before M0b completion:** Three role slots **stack and cap concurrent personal +1 awards at three** (settled). Decide which of the three stable role IDs Dusk may assign when an unused slot exists, in what order, and how that coexists with other ways of earning each role without corrupting attribution. Confirm Elle's winner-removal process covers Dusk-funded awards and determine reliable win/consumption evidence for later repurchase. Set initial eligibility, provisional pricing and non-win failure/refund terms. **Funded repurchase after a confirmed win is agreed**; no code, role changes, currency issuance or launch has been approved.

**Future-proofing for M6:** An eventual clan sponsor can fund grants to multiple **eligible unique** Discord members under the same role-entitlement model, subject to a separately agreed sponsorship price, service milestone, organizer budget, participant caps and sponsor-specific authorization. Do **not** implement bulk grants, a clan treasury or a Rising Maple integration during M1a or the personal proof of concept.

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
| **M0 — Policy and evidence audit** | P0 | In progress — M0a complete; M0b three-role stacking cap and win-consumed lifetime settled, mapping/terms pending | Evidence audit and SELECT-only simulation reviewed. Elle endorses +1 giveaways. Three stacking personal +1 roles carry forward until a win; a holder of all three cannot purchase another. Dusk slot mapping, eligibility, price and non-win remedies remain open; clean-FWA UNKNOWN and no issuance approved |
| **M1 — Ledger and Dusk hub** | P0 | Not started | Transaction-safe wallet/ledger, idempotency, admin audit/adjust/reverse, read-only `/dusk` balance/history, tests/docs/permission coverage; no payout rules yet |
| **M2 — Verified earning engine** | P0 | Not started | Start with a small set of reliable signals; per-user limits, no duplicate payouts, replay/recovery and manual reconciliation; expand BL/clean-war only after eligibility proof |
| **M3 — Personal Market redemption** | P1 | Not started | Personal +1 proof of concept using an approved mapping to an **unused slot in the three-role cap**: price/eligibility controls, all-role capacity check, source-aware idempotent ledger + role grant, winner-consumption cycles and audit/reconciliation. No fourth personal +1 role or role grant until approved |
| **M4 — Alliance Transfer Pool** | P1 | Not started | Opt-in/preferences, read-only opportunities, optional coordinated campaigns, verified completions, Home-safe updates; transfer rewards only after evidence |
| **M5 — Engagement & recognition** | P2 | Not started | Weekly quests, profiles, configurable per-clan/alliance rankings, achievements; raw Clash stats separated from earned Duskits |
| **M6 — Clan Sponsor / treasury** | P2 | Deferred | Extend verified role-entitlement fulfillment to multiple eligible unique members only after the personal flow works and sponsorship price, service rule, organizer budget, entry limits and authorization are confirmed. Pooled treasury optional |

### Implementation slices — scoped PRs, not one giant change

- [x] M0a part 1: Document eligibility/evidence sources, query designs and hard UNKNOWN states. See [Dusk reward evidence diagnostic](../diagnostics/dusk-reward-evidence.md). No database sample or reward issuance was performed.
- [x] M0a part 2: Ran and reviewed a real eight-week, one-guild SELECT-only historical earnings simulation and a post-fix rerun against the same fixed scope. The corrected classifier eliminated 5,900 war-end-only identity conflicts without issuing or recognizing any clean-FWA rewards: all 199 rosters remain unproven. Recognized FWA rep work and draft calibration are documented in the [historical earnings simulation diagnostic](../diagnostics/dusk-historical-earnings-simulation.md). This closes the **simulation/review task only**, not reward eligibility, rate approval, or issuance.
- [ ] M0b: Elle's endorsement, personal-first delivery, **three stacking +1 role slots with a shared maximum of three**, win-consumed lifecycle and funded post-win repurchase are agreed. Decide safe use of available existing role IDs and reward-source provenance, verify winner-removal and win evidence, and settle initial eligibility, pricing, non-win refunds and member-facing terms. No Rising Maple integration or per-purchase manual fulfillment assumed. Clan sponsorship deferred; **M0b not complete**.
- [ ] M1a: Ledger transaction + policy schema, safe migration and ownership boundaries (no commands).
- [ ] M1b: Wallet/query/admin adjustments, permissions, help, tests and readme.
- [ ] M2a: One reliable reward source end-to-end including active-only reconciler, dedupe, observability and rollback/reversal tests.
- [ ] M2b: Add other verified sources and caps only after audits.
- [ ] M3–M6: Split each milestone into small service/persistence, commands/UI and verification/reliability PRs after preceding scope is reviewed.

**Mandatory release gates:** no architecture ownership conflicts, no accidental reward issuance in staging, deterministic repeated-event handling, no negative wallet or double redemption, no regression to existing war/mail/sync/reminder flows, migration safety, documented permission targets, robust tests, production metrics and a rollback/disable switch.

## Open questions / decisions to make before launch

- [ ] **Discord role fulfillment boundaries:** Elle's endorsement, win-consumed lifetime, paid post-win repurchase and **three-role stacking cap** are agreed. Select which existing +1 role IDs Dusk can grant to an empty slot without taking ownership of other award sources. Verify winner-removal/consumption evidence, initial eligibility, no-duplicate role grants, non-win refunds and Discord permissions. Sponsorship deferred.
- [ ] **Existing bonus-role coexistence:** The **three distinct +1 roles stack**, and a holder of all three cannot buy another personal +1. Roles remain until a win, when Elle removes the winner's +1s. Preserve other-award provenance, resolve authorized slot assignment with existing acquisition avenues, and do not introduce a fourth personal counting role by default. No Rising Maple API requirement.
- [ ] **Entry eligibility / promotional terms:** Confirm launch eligibility and giveaway-rule constraints. **Current holders of all three stacking +1 roles cannot buy another personal +1**. After verified consumption, members may buy with sufficient Duskits and an available slot, without lifetime bans or a post-win cooldown. Do giveaway rules require a free alternative or other constraints?
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
| 2026-11-12 | User provided screenshot showing separately earned `+1 [Giveaway Entry]` Discord roles (three visually distinct punctuation variants), Clan Games multiplier roles, and a `+3 Sponsored Clan` role. Giveaway participation is role-defined, not an external Rising Maple fulfillment process; Dusk-specific role ID and stacking remain unverified | Observed existing role surface; proposed Dusk-owned role model, no integration requirement |
| 2026-11-12 | Project owner clarified **Elle manually removes all +1 giveaway roles when a member wins**; otherwise they persist between giveaways. A Dusk +1 should therefore be win-consumed, not reset every drawing. Need confirmed winner-consumption provenance before any new purchase; role disappearance alone does not establish a win | Agreed/user-reported giveaway rule; consumption evidence mechanism open |
| 2026-11-12 | After winning, members **may purchase another Dusk-funded +1** as soon as they have enough Duskits and an available personal slot; each paid purchase starts a new win-consumed entitlement. No permanent one-purchase limit or post-win cooldown | Agreed; must prevent duplicate occupied-role grants and prove prior win |
| 2026-11-12 | Project owner confirmed the **three distinct personal +1 giveaway roles stack** and a member holding **all three** must not be allowed to purchase another through Duskits. Clan-wide +1 sponsorship is a later, separate shop reward. Do not introduce a fourth counted role or assume the existing slots are freely assignable without provenance/role-ownership agreement | Agreed cap and stacking; slot assignment method remains proposed/unresolved |
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

**Next action:** Agree how Dusk can assign an **unoccupied one of the three existing +1 role slots** while preserving other reward-source ownership; then settle winner-consumption evidence, launch eligibility, pricing, non-win refunds and member-facing terms. The **three-role stacking cap** and **post-win funded repurchase** are already agreed. **Post-win repurchase with sufficient Duskits is already agreed.** Then scope M1a's separate wallet/ledger ownership; no Rising Maple API or manual external fulfillment is assumed. Treat sponsorship as an M6 follow-on rather than a personal proof-of-concept dependency. Do not treat the completed simulation as approval for rates, clean-FWA eligibility, retroactive rewards, production deployment, or issuance. **No code or reward issuance is authorized by this roadmap alone.**
