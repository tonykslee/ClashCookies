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
| Personal entry price | **Agreed initial shop price** | **100 Duskits** for one dedicated Duskits +1 Discord role. This is a product-price decision, **not** permission for live wallet spending, role granting or payouts; earning rates and affordability remain to be validated |
| Routine earn-rate target | **Proposal** | ~15–20 Duskits/week; routine weekly cap 30 |
| Clan-wide sponsorship price | **Proposal** | 500 Duskits **plus** eligibility milestone; price/scale requires review |
| Transfer reward | **Proposal** | +20 verified transfer; +10 after 14 days in destination |
| +1 giveaway inclusion | **Explicitly endorsed (user-confirmed)** | Elle has given permission **and advocacy** for including +1 giveaway rewards in Dusk. No need to re-request general approval of the concept; this is not permission for automated fulfillment or unlimited entries |
| First giveaway delivery scope | **Agreed direction** | Personal +1 first using Discord roles: +1 roles persist across giveaways and **Elle removes all of a winner's +1 roles when they win**. Sponsorship stays deferred to M6 |
| Personal +1 stacking | **Agreed** | The three existing +1 roles continue stacking as they do today. The **separate Duskits +1** stacks on top of them, so a member holding all three existing roles may still buy Duskits +1 (four +1 roles total). No shared three-role purchase cap applies to Duskits |
| Dusk purchase role mapping | **Agreed** | Add **one distinct Duskits-owned +1 Discord role**, not any of the three existing roles. Dusk only sells/grants its own role and does not assign or modify roles earned through other avenues |
| Dusk purchase quantity | **Agreed** | Maximum **one active Duskits +1 role per Discord member**. While held it cannot be purchased again; after an authorized leader consumes/removes it for a win, the member can rebuy with sufficient Duskits. No cooldown or lifetime ban |
| Dedicated role identity | **User-confirmed created; integration unverified** | Discord role ID **`1570682697649754142`**, displayed as **`+1 [Giveaway Entry];`** (punctuation is significant). Resolve by role ID, not display text. Giveaway counting, bot permissions and inclusion in winner cleanup must still be verified |
| Initial redemption eligibility | **Agreed criteria; evidence implementation pending** | Minimum **two months' alliance membership**; no violations in preceding 30 days; complete required attacks within compliance during preceding 30 days; satisfy each applicable base-swap prompt (or already swapped) with required acknowledgment; resolve flagged base errors within the posting sync and acknowledge the base-swap post |
| Voluntary refunds | **Not supported** | No return/exchange of a valid granted role for Duskits. Correct a verified failed delivery, duplicate charge or ledger error with an auditable technical reversal; no refund solely because a winner's role was properly consumed |
| Dusk +1 repurchase after a win | **Agreed** | After a member wins and their previous Dusk +1 is consumed/removed, they may buy a new Dusk +1 **whenever they have sufficient Duskits**. No permanent one-time-purchase restriction or post-win cooldown was requested |
| Concrete command and DB names | **Design draft** | Confirm in implementation PRs, not fixed APIs yet |

**Important:** Elle's permission and advocacy for Dusk +1 giveaways are confirmed by the project owner. The user has clarified that the current giveaway-entry mechanism is based on **Discord roles**, not a separately maintained Rising Maple entry registry. Do not require a Rising Maple API or manual third-party entry registration as a default prerequisite. The **dedicated Duskits role was created** with confirmed ID **`1570682697649754142`**; its giveaway-count configuration, bot permissions, winner-consumption proof, eligibility evidence completeness, concurrent-purchase safeguards and technical-failure handling remain to be verified; **one active Duskits +1 that stacks independently of all existing +1 roles, and winner-consumption by Elle are user-confirmed**; no automatic redemption or clan sponsorship is authorized by this design note.

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

- **100 Duskits / dedicated personal +1 (agreed initial price):** one purchase buys the **single dedicated Duskits role** until its holder wins a giveaway (when Elle removes all their +1 roles), not merely one drawing. The owner confirmed **100 Duskits** as the initial shop price; it may be reviewed separately in a future policy decision. The hypothesized ~15–20 Duskits/week would reach 100 in ~5–7 weeks, but the eight-week rep-work simulation did **not** establish that pace for typical members. **Price agreement does not validate earning rates, affordability, issuance or launch**; do not inflate earning rates to force that timeline.
- **500 Duskits + ~6-month eligibility / clan-wide +1:** exceptional recognition, not ordinary bulk pricing. One sponsor may grant an extra entry to each *eligible unique Discord participant*, not each CoC account. Eligibility and giveaway caps must be checked at redemption.
- The clan-wide price is deliberately discounted relative to buying dozens of individual entries; this requires explicit organizer approval and an alliance-wide issuance budget.
- No Duskits-for-real-money purchase, cash-out, player-to-player currency transfers, or gambling mechanics in the initial design.
- Members should not be required to triple, be a rep, or accept a transfer to achieve ordinary personal progress.

### M0b giveaway governance — personal-first, dedicated Discord role

**Agreed / user-confirmed product policy (2026-11-12):**
- Elle permits and advocates a Dusk-funded +1 giveaway reward. Start with the **personal +1** proof of concept; defer clan-wide sponsorship to M6.
- The dedicated role has **already been created** in Discord: **`+1 [Giveaway Entry];`**, role ID **`1570682697649754142`**. The ID is authoritative; the display name and its punctuation are not an identifier. Creation is user-confirmed, but actual giveaway counting, permissions and bot integration have **not** been verified.
- Dusk grants only this dedicated role, **not** any of the three existing +1 roles. The Duskits role stacks independently with them: holders of the original three may have **four +1 roles total**. No cross-source three-role cap applies to a Duskits purchase.
- Each Discord member (across all linked CoC accounts) may hold **at most one active Duskits +1 role**. While it is active they cannot buy another, regardless of balance. The **initial price is 100 Duskits**.
- +1 roles persist between drawings until their holder wins. **An authorized alliance leader manually consumes the benefit by removing the winner's +1 roles**, including the dedicated Duskits role. This is an operational step, not an automated Dusk scheduler. After verified win-consumption, the member can purchase the Duskits role again whenever they have enough Duskits; no lifetime ban or post-win cooldown.
- **No voluntary returns/refunds** for valid, successfully delivered role entitlements, and no refund because the role was properly consumed on a win. Technical reversals for verified failed delivery or duplicate/incorrect charges are distinct from voluntary refunds.
- Giveaway participation uses Discord roles; no Rising Maple API or external per-purchase fulfillment registry is required by the agreed product direction.

**Agreed eligibility criteria — evaluate at the time of purchase:**
1. **Minimum two months of alliance membership.** This is alliance-wide, not two months in one particular clan. How to prove tenure across inter-clan moves, breaks and incomplete observation history remains an implementation/evidence decision; do not guess a date from a current roster.
2. **No violations in the preceding 30 days.** Interpret this against authoritative, finalized compliance findings and the relevant member's linked accounts. Missing or pending evaluations must not be treated as a proven clean history.
3. **All required attacks completed within compliance in the preceding 30 days.** Evaluate applicable participation only: no failure for a war the member was not obligated to attack in. Require persisted war-specific attack obligations, use and compliance evidence rather than assuming roster presence, zero recorded violations or a missing row proves completion.
4. **Every applicable base-swap prompt honored in the preceding 30 days, with reaction/acknowledgment on its post.** If the member already swapped beforehand, that satisfies the underlying swap obligation; separately clarify whether acknowledgment was still required in that case. Do not fail someone for a prompt never applicable to them.
5. **Any flagged base error resolved within the sync in which it was posted, with reaction/acknowledgment on the base-swap post.** Use the canonical posting sync as the deadline; do not substitute a fabricated timestamp or automatically accept an unverified correction.

**Evidence / implementation constraints (not automatic eligibility yet):**
- `WarPlanComplianceEvaluation`/`WarPlanViolation` and `ClanWarParticipation` are relevant to finalized findings, required attacks and coverage, but the historical clean-FWA simulation found canonical roster completeness unproven. `WarPlanViolationHistoryService` already supports a 30-day period; its query alone does **not** prove all five purchase requirements.
- `AllianceClanMembershipInterval` stores **observed** membership intervals (not exact join/transfer instants). Two-month alliance tenure and continuity across clans/linked accounts need a bounded, explicit evidence rule; ambiguous gaps stay `UNKNOWN`.
- Base-swap post `TrackedMessage.metadata.entries[].acknowledged` is **mutable current state with no per-ack timestamp**; acknowledgments do not independently prove an in-game base change or its timing. Existing base-error notes do not establish a reliable historical time-of-fix. The 30-day "every prompt" rule and resolution-before-sync-deadline require additional provenance or authorized manual review rather than retroactive inference.
- Treat **not applicable**, **verified pass**, **verified failure**, and **unknown/insufficient evidence** separately. Unknown is **not** a silent pass; also do not label a member a violator solely because the bot lacks historical coverage. Define an authorized, auditable leader review/exception mechanism for incomplete evidence, without rewriting operational records or granting on unverified assertions.
- Check one active entitlement and sufficient balance at purchase, record a durable idempotent purchase, and verify the role grant before final spending. Ledger and Discord grants are not atomic; duplicate requests, unknown Discord outcomes, bot restarts and manual leader removal must be reconciled. **A missing role alone does not prove a giveaway win**, so another paid purchase requires credible consumption provenance. Active production only; staging mirror does not grant roles, spend currency or change winner state.
- **Non-win technical correction:** On verified grant failure, erroneous/duplicate charge or other proven non-fulfillment, restore the amount through an auditable compensating ledger entry; this is **not** a member-requested refund feature. A properly delivered role later removed for a win is not refundable. Unexplained removal, policy cancellation and administrative errors require a narrowly defined manual review process, not automatic Duskits reimbursement.

**Open before completing M0b:** Verify role ID `1570682697649754142` in guild/config, +1 giveaway counting, Dusk `Manage Roles` permissions and leader winner cleanup. Define historical tenure coverage, 30-day all-account compliance/attack coverage, base-swap and base-error evidence, already-swapped acknowledgment requirement, and audited leader adjudication when evidence is incomplete. Agree exact deadlines, cancellation/technical correction handling and member-facing rules. No currency issuance, code deployment, automatic role grants or production writes are authorized by this roadmap.

**M6 extensibility:** Clan-wide sponsorship is a **separate** Dusk Market reward with its own eligibility, recipients and funding. Do not implement pooled treasury or bulk grants in the personal proof of concept.

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
| **M0 — Policy and evidence audit** | P0 | In progress — M0a complete; M0b role ID and eligibility policy confirmed, enforceability pending | Evidence audit and SELECT-only simulation reviewed. Dedicated role ID `1570682697649754142` is user-confirmed created; 100-Duskit price, one-active limit, manual leader winner-consumption and five eligibility criteria agreed. Evidence coverage, actual role counting, permissions and technical error corrections require verification. Clean-FWA UNKNOWN; no issuance approved |
| **M1 — Ledger and Dusk hub** | P0 | Not started | Transaction-safe wallet/ledger, idempotency, admin audit/adjust/reverse, read-only `/dusk` balance/history, tests/docs/permission coverage; no payout rules yet |
| **M2 — Verified earning engine** | P0 | Not started | Start with a small set of reliable signals; per-user limits, no duplicate payouts, replay/recovery and manual reconciliation; expand BL/clean-war only after eligibility proof |
| **M3 — Personal Market redemption** | P1 | Not started | Personal +1 proof of concept: role ID `1570682697649754142`, one active Duskits entitlement per Discord member, 100-Duskit spend, enforce 2-month alliance tenure and 30-day compliance/swaps/error rules with evidence/leader review. Idempotent ledger/role grant, manual win-consumption cycles and technical corrections; no live grant until approved |
| **M4 — Alliance Transfer Pool** | P1 | Not started | Opt-in/preferences, read-only opportunities, optional coordinated campaigns, verified completions, Home-safe updates; transfer rewards only after evidence |
| **M5 — Engagement & recognition** | P2 | Not started | Weekly quests, profiles, configurable per-clan/alliance rankings, achievements; raw Clash stats separated from earned Duskits |
| **M6 — Clan Sponsor / treasury** | P2 | Deferred | Extend verified role-entitlement fulfillment to multiple eligible unique members only after the personal flow works and sponsorship price, service rule, organizer budget, entry limits and authorization are confirmed. Pooled treasury optional |

### Implementation slices — scoped PRs, not one giant change

- [x] M0a part 1: Document eligibility/evidence sources, query designs and hard UNKNOWN states. See [Dusk reward evidence diagnostic](../diagnostics/dusk-reward-evidence.md). No database sample or reward issuance was performed.
- [x] M0a part 2: Ran and reviewed a real eight-week, one-guild SELECT-only historical earnings simulation and a post-fix rerun against the same fixed scope. The corrected classifier eliminated 5,900 war-end-only identity conflicts without issuing or recognizing any clean-FWA rewards: all 199 rosters remain unproven. Recognized FWA rep work and draft calibration are documented in the [historical earnings simulation diagnostic](../diagnostics/dusk-historical-earnings-simulation.md). This closes the **simulation/review task only**, not reward eligibility, rate approval, or issuance.
- [ ] M0b: **Agreed:** 100-Duskit personal price; dedicated Discord role `1570682697649754142` user-confirmed created; independent stacking; one active role; manual leader consumption on a win; repurchase after consumption; 2-month alliance tenure plus the four 30-day compliance, attack, swap and base-error requirements; no voluntary refunds. **Remaining:** verify actual giveaway weight, role permissions and winner cleanup; define evidence coverage and manual adjudication for missing historical data, technical error corrections, deadline details and member-facing rules. M6 sponsorship deferred. **M0b not complete**.
- [ ] M1a: Ledger transaction + policy schema, safe migration and ownership boundaries (no commands).
- [ ] M1b: Wallet/query/admin adjustments, permissions, help, tests and readme.
- [ ] M2a: One reliable reward source end-to-end including active-only reconciler, dedupe, observability and rollback/reversal tests.
- [ ] M2b: Add other verified sources and caps only after audits.
- [ ] M3–M6: Split each milestone into small service/persistence, commands/UI and verification/reliability PRs after preceding scope is reviewed.

**Mandatory release gates:** no architecture ownership conflicts, no accidental reward issuance in staging, deterministic repeated-event handling, no negative wallet or double redemption, no regression to existing war/mail/sync/reminder flows, migration safety, documented permission targets, robust tests, production metrics and a rollback/disable switch.

## Open questions / decisions to make before launch

- [ ] **Discord role fulfillment boundaries:** User-confirmed new role `1570682697649754142` (display `+1 [Giveaway Entry];`). Verify its counted +1, bot permissions and inclusion in **manual leader winner cleanup**. Consumption provenance and technical correction flow are unimplemented; maintain one active Duskits role, idempotent purchase and no discretionary refund. Sponsorship deferred.
- [ ] **Existing bonus-role coexistence:** The original three +1 roles continue to stack and are **untouched by Dusk**. A member may hold all three plus **one Duskits +1** (four total). Confirm the giveaway counts the new role as an independent entry and Elle's winner-removal workflow covers it. No Rising Maple API requirement.
- [ ] **Entry eligibility evidence:** Policy agreed: 2 months' alliance membership; no violations in prior 30 days; all required war attacks used compliantly in prior 30 days; all applicable base-swap prompts honored with reaction (or already swapped); flagged base errors resolved within their posting sync and acknowledged. Define alliance tenure gaps/transfer treatment, applicable obligations, historical base-swap/error timing and manual exception provenance. Avoid auto-qualifying on missing data.
- [ ] **Giveaway promotional terms:** A funded member with any existing +1 roles may buy one dedicated Duskits +1 while not holding it, subject to the agreed evidence criteria. Confirm event-specific rules and whether a free alternative or other restrictions are required.
- [ ] **Coin budget:** Keep the agreed **100-Duskit initial personal entry price** distinct from unvalidated earning pace and affordability; calibrate real earning distributions, multi-account effect and future clan sponsor liability using observed data. Do not silently change the agreed price to compensate for weak evidence.
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
| 2026-11-12 | Aim for personal +1 after ~1–2 months, clan-wide sponsor after ~6 months | Time horizons, sponsor price and earning rates remain provisional; personal +1 price subsequently agreed at 100 Duskits |
| 2026-11-12 | Project owner reconfirmed Elle's **permission and advocacy** for +1 giveaways in Dusk; general concept approval is settled, while specific event funding, fulfillment, limits and automation remain undecided | Explicit endorsement confirmed (user-reported); operational terms open |
| 2026-11-12 | Prioritize a **personal +1 proof of concept** using Discord roles; later confirmation establishes that +1 roles persist across giveaways until a win. Keep extensible for future clan sponsors without bulk funding or treasury now | Agreed direction; win-consumed lifetime confirmed; sponsorship deferred to M6 |
| 2026-11-12 | User provided screenshot showing separately earned `+1 [Giveaway Entry]` Discord roles (three visually distinct punctuation variants), Clan Games multiplier roles, and a `+3 Sponsored Clan` role. Giveaway participation is role-defined, not an external Rising Maple fulfillment process; exact role IDs were not provided, while role stacking was subsequently confirmed by the project owner | Observed role surface; later stacking confirmation recorded separately; no integration requirement |
| 2026-11-12 | Project owner clarified **Elle manually removes all +1 giveaway roles when a member wins**; otherwise they persist between giveaways. A Dusk +1 should therefore be win-consumed, not reset every drawing. Need confirmed winner-consumption provenance before any new purchase; role disappearance alone does not establish a win | Agreed/user-reported giveaway rule; consumption evidence mechanism open |
| 2026-11-12 | After winning, members **may purchase another Dusk-funded +1** as soon as they have enough Duskits and their previously purchased Duskits role was consumed; each purchase starts a new win-consumed entitlement. No permanent one-purchase limit or post-win cooldown | Agreed; must prevent duplicate active Duskits grants and prove prior win |
| 2026-11-12 | Earlier discussion established that the **three existing +1 roles stack** and initially proposed buying available slots among those three | **Superseded** for Dusk purchases by later dedicated-role decision; existing three roles still stack |
| 2026-11-12 | Earlier design allowed purchasing any missing existing +1 role, potentially all three with funds | **Superseded** by dedicated Duskits role with one active purchase |
| 2026-11-12 | Project owner selected a **separate Duskits +1 role** which stacks with all three existing +1s (allowing four total) and cannot be bought again **while active**. On a win Elle consumes/removes it with the other roles, after which it may be purchased again if funded | **Agreed** personal-role policy for M0b; role ID and launch mechanics pending |
| 2026-11-12 | Project owner confirmed **100 Duskits** as the **initial price for one dedicated Duskits +1 giveaway role**, without a live issuance or deployment authorization | **Agreed initial shop price**; earning-rate calibration and rollout safeguards still required |
| 2026-11-12 | Project owner reported creating dedicated role **`+1 [Giveaway Entry];`** ID **`1570682697649754142`**; clarified **authorized leader manually removes winner roles**, established 2-month alliance tenure plus 30-day zero violations / compliant attacks / prompt-and-ack swap / in-sync base-error resolution eligibility, and rejected voluntary returns for Duskits. Technical reversal remains a proposed safety correction, not a member return option | **Agreed product policy and user-reported role creation**; historical evidence sufficiency, live role counting/permissions and operational exception rules pending |
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

**Next action:** Verify user-created dedicated role `1570682697649754142` counts as +1 and authorized leaders remove it on a win. Finalize verifiable two-month tenure, 30-day war/swap/base-error eligibility coverage, manual adjudication for UNKNOWN evidence and non-win technical correction rules, then publish member-facing terms. **Price (100 Duskits), one active role and no voluntary refunds are agreed.** Then scope M1a's wallet/ledger ownership; no Rising Maple API or manual external fulfillment is assumed. Treat sponsorship as an M6 follow-on rather than a personal proof-of-concept dependency. Do not treat the completed simulation as approval for rates, clean-FWA eligibility, retroactive rewards, production deployment, or issuance. **No code or reward issuance is authorized by this roadmap alone.**
