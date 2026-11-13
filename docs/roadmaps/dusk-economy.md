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
| First giveaway delivery scope | **Agreed direction** | Personal +1 entry first as a proof of concept; build a small event-scoped redemption/fulfillment boundary that can later support clan sponsorship without implementing it now |
| Concrete command and DB names | **Design draft** | Confirm in implementation PRs, not fixed APIs yet |

**Important:** Elle's permission and advocacy for Dusk +1 giveaways are confirmed by the project owner; the general concept does **not** need to be re-approved. Operational terms (event availability, who fulfills/funds an entry, eligibility, limits, cancellations and Rising Maple coordination) are still open. This does not authorize automatic fulfillment or assume bulk clan-wide sponsorship, its funding, or an integration API has been agreed.

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

- **100 Duskits / personal +1 (proposal):** ~15–20 Duskits/week would reach the draft price in ~5–7 weeks, but the eight-week rep-work simulation did **not** establish that pace for typical members. Keep both the price and time horizon provisional; do not inflate earn rates to compensate for limited observed participation.
- **500 Duskits + ~6-month eligibility / clan-wide +1:** exceptional recognition, not ordinary bulk pricing. One sponsor may grant an extra entry to each *eligible unique Discord participant*, not each CoC account. Eligibility and giveaway caps must be checked at redemption.
- The clan-wide price is deliberately discounted relative to buying dozens of individual entries; this requires explicit organizer approval and an alliance-wide issuance budget.
- No Duskits-for-real-money purchase, cash-out, player-to-player currency transfers, or gambling mechanics in the initial design.
- Members should not be required to triple, be a rep, or accept a transfer to achieve ordinary personal progress.

### M0b giveaway governance — personal-first proof of concept

**Agreed product direction (2026-11-12):**
- Elle explicitly permits and advocates including Dusk-funded +1 giveaway entries (confirmed by the project owner); stop treating permission for the concept as an unresolved blocker.
- **Personal +1 first.** Deliver one member-initiated extra-entry request for a specified giveaway as the proof of concept. Clan-wide sponsorship is a future extension in M6, not required for personal launch.
- Keep **one Discord identity across linked CoC accounts**. A giveaway entry belongs to an eligible unique member, never to each account. Dusk must not itself declare a Rising Maple entry issued.

**Proposed initial controls — not final policy or implementation approval:**
- Retain the draft **100-Duskit personal price** for later calibration. Suggest at most one Dusk-funded personal bonus entry per unique member per giveaway, subject to the organizer's event rules and combined entry limits.
- Start with **manual organizer fulfillment** and an explicit per-giveaway confirmation/reference. A requested entry remains pending until the organizer verifies it against the authoritative giveaway roster (including Rising Maple where used); do not claim a working Rising Maple API or assume cross-system dedupe without that check.
- When implemented in M3, reserve the Duskits while a request is pending; finalize spending only upon verified fulfillment. If rejected, expired or cancelled before fulfillment, release the reservation; if a confirmed entry is invalidated by organizer cancellation/error, record an auditable compensating refund. No automatic fulfillment or payout now.
- Publish concise event-specific terms before enabling redemption: eligibility, availability, entry limit, deadline, organizer, cancellation/refund policy, and any applicable promotion requirements (including free-entry rules if relevant).

**Unresolved operational decisions:** Which organizer owns confirmation and prize funding per event; which specific giveaways accept Dusk entries; how the organizer checks the combined Rising Maple/Dusk entry limits and records the authoritative confirmation; event-specific restrictions and cancellation policy. Elle's endorsement of the concept should not be conflated with approval of these mechanics.

**Future-proofing without prebuilding M6:** Keep the redemption boundary event-scoped with one purchaser, identifiable eligible beneficiary/beneficiaries and an organizer fulfillment reference. Later a clan sponsor could fund multiple **distinct, eligible** recipients under the same event and dedupe limits, with a separate sponsor price, service milestone, budget and authorization. Do **not** implement a clan treasury, bulk issuance workflow or automated Rising Maple integration during M1a/M3 personal proof of concept.

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
| **M0 — Policy and evidence audit** | P0 | In progress — M0a complete; M0b personal-first direction recorded, operational terms pending | Evidence audit and bounded historical SELECT-only simulation reviewed. Elle endorses +1 giveaways; personal entry is the proof of concept, sponsorship deferred. Rep-work is the strongest modeled evidence; clean-FWA remains UNKNOWN. Pricing, event eligibility, fulfillment controls and budget remain provisional; no issuance approved |
| **M1 — Ledger and Dusk hub** | P0 | Not started | Transaction-safe wallet/ledger, idempotency, admin audit/adjust/reverse, read-only `/dusk` balance/history, tests/docs/permission coverage; no payout rules yet |
| **M2 — Verified earning engine** | P0 | Not started | Start with a small set of reliable signals; per-user limits, no duplicate payouts, replay/recovery and manual reconciliation; expand BL/clean-war only after eligibility proof |
| **M3 — Personal Market redemption** | P1 | Not started | Personal +1 proof of concept: event-scoped eligibility and provisional price controls, manual organizer confirmation, hold/commit/refund, per-giveaway dedupe and audit trail; no automated prize issuance |
| **M4 — Alliance Transfer Pool** | P1 | Not started | Opt-in/preferences, read-only opportunities, optional coordinated campaigns, verified completions, Home-safe updates; transfer rewards only after evidence |
| **M5 — Engagement & recognition** | P2 | Not started | Weekly quests, profiles, configurable per-clan/alliance rankings, achievements; raw Clash stats separated from earned Duskits |
| **M6 — Clan Sponsor / treasury** | P2 | Deferred | Extend the proven personal redemption boundary to multiple eligible unique beneficiaries only after sponsorship price, six-month service rule, organizer funding, entry limits and approval are confirmed. Pooled treasury is optional, not a requirement |

### Implementation slices — scoped PRs, not one giant change

- [x] M0a part 1: Document eligibility/evidence sources, query designs and hard UNKNOWN states. See [Dusk reward evidence diagnostic](../diagnostics/dusk-reward-evidence.md). No database sample or reward issuance was performed.
- [x] M0a part 2: Ran and reviewed a real eight-week, one-guild SELECT-only historical earnings simulation and a post-fix rerun against the same fixed scope. The corrected classifier eliminated 5,900 war-end-only identity conflicts without issuing or recognizing any clean-FWA rewards: all 199 rosters remain unproven. Recognized FWA rep work and draft calibration are documented in the [historical earnings simulation diagnostic](../diagnostics/dusk-historical-earnings-simulation.md). This closes the **simulation/review task only**, not reward eligibility, rate approval, or issuance.
- [ ] M0b: Elle's endorsement and the personal-first proof-of-concept direction are recorded. Finish per-event organizer/funding authority, Rising Maple duplicate-check process, personal eligibility/limits, cancellation/refund terms and member-facing rules. Clan sponsorship stays deferred to M6; M0b is **not complete**.
- [ ] M1a: Ledger transaction + policy schema, safe migration and ownership boundaries (no commands).
- [ ] M1b: Wallet/query/admin adjustments, permissions, help, tests and readme.
- [ ] M2a: One reliable reward source end-to-end including active-only reconciler, dedupe, observability and rollback/reversal tests.
- [ ] M2b: Add other verified sources and caps only after audits.
- [ ] M3–M6: Split each milestone into small service/persistence, commands/UI and verification/reliability PRs after preceding scope is reviewed.

**Mandatory release gates:** no architecture ownership conflicts, no accidental reward issuance in staging, deterministic repeated-event handling, no negative wallet or double redemption, no regression to existing war/mail/sync/reminder flows, migration safety, documented permission targets, robust tests, production metrics and a rollback/disable switch.

## Open questions / decisions to make before launch

- [ ] **Giveaway fulfillment boundaries:** Elle's permission and advocacy for +1 inclusion are confirmed by the project owner. Confirm the event-by-event fulfillment/funding owner, qualifying giveaways, per-event caps and cancellations/refunds. Clan-wide bulk sponsorship remains deferred rather than a personal-launch blocker.
- [ ] **Rising Maple coexistence:** Manual fulfillment first, supported integration, or shared redemption coordinator? Avoid double-awards.
- [ ] **Entry eligibility / promotional terms:** Who qualifies, how many bonus entries may exist per user/event, and do giveaway rules require a free alternative or other constraints?
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
| 2026-11-12 | Prioritize a **personal +1 proof of concept**; keep redemption event-scoped and extensible to future clan sponsors without implementing bulk funding or treasury now | Agreed delivery direction; clan sponsorship deferred to M6 |
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

**Next action:** Finish only the remaining M0b personal +1 operational rules (event owner/funding, eligibility, terms, manual Rising Maple coordination), then scope M1a's separate wallet/ledger ownership. Treat sponsorship as an M6 follow-on rather than a personal proof-of-concept dependency. Do not treat the completed simulation as approval for rates, clean-FWA eligibility, retroactive rewards, production deployment, or issuance. **No code or reward issuance is authorized by this roadmap alone.**
