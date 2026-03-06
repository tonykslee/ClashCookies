# Discord Guidebook Plan: FWA Leader Workflows

This guide gives you a **forum-first structure** and ready-to-paste post copy for teaching alliance leaders how to use the bot.

## Recommended structure

Use a **Forum channel** (like your screenshot) with:

1. **One pinned index post** (`START HERE`) that links to each feature post.
2. **One post per workflow/use case** (instead of one giant post).
3. Consistent tags (example: `Leaders`, `Recruiter`, `War Prep`, `War Spin`, `Tracking`).

Why this works:
- Leaders can find the exact workflow quickly.
- You can update one workflow without rewriting everything.
- Screenshots stay focused and easier to maintain.

---

## Post map (what to create)

Create these forum posts in this order:

1. `START HERE — Dusk Bot Leader Playbook` (index + navigation)
2. `Add a Tracked Clan (Foundation Setup)`
3. `Prepare for War Composition (/compo state)`
4. `Start War + Send FWA Mail`
5. `Recruitment Workflow (Scripts + Countdown)`
6. `Place New Recruits by Weight`
7. `Troubleshooting + Common Mistakes`

---

## 1) Copy template: START HERE post

**Title:**
`START HERE — Dusk Bot Leader Playbook`

**Body (paste this):**

Welcome to the leader playbook for Dusk bot workflows used in alliance FWA operations.

### Who this is for
- Clan leaders
- Co-leaders managing war prep
- Recruiters and placement coordinators

### Use these guides
1. Add a Tracked Clan (Foundation Setup)
2. Prepare for War Composition (`/compo state`)
3. Start War + Send FWA Mail
4. Recruitment Workflow (`/recruitment ...`)
5. Place New Recruits by Weight (`/compo state`)
6. Troubleshooting + Common Mistakes

### Expected outcome
If you follow these posts, you will be able to:
- Keep tracked clans fully configured
- Build correct composition before spin
- Send accurate FWA war mails quickly
- Run recruitment countdowns and scripts consistently
- Place recruits into the right-weight clans faster

---

## 2) Copy template: Add a Tracked Clan

**Title:**
`Add a Tracked Clan (Foundation Setup)`

**Suggested tags:**
`Leaders`, `Tracking`, `Setup`

**Body:**

### Why this matters
Tracking is the base layer for automation. Without it, leaders lose war mail automation, reliable logs, and structured player tracking.

### Command
`/tracked clan configure`

### When to use
- New clan joins alliance
- Clan tag changes or management handoff
- Bot setup audit after role/permission updates

### Steps
1. Run `/tracked clan configure` in the designated bot/admin channel.
2. Select/confirm the correct clan tag and linked context.
3. Verify tracking outputs are enabled (war mail workflows, war logs, player tracking).
4. Run a quick validation check (example: use a related tracking/read command your team already uses).

### Success criteria
- Clan appears in tracked configuration
- War events/log outputs begin populating
- Leadership can use downstream workflows without manual workarounds

### Leader benefit
- Less manual coordination
- Faster war-day execution
- Consistent data for placement and mail workflows

### Screenshot checklist
- Slash command entry (`/tracked clan configure`)
- Completed confirmation output
- Evidence of tracking active (e.g., log message/output)

---

## 3) Copy template: Prepare for War Composition

**Title:**
`Prepare for War Composition (/compo state)`

**Suggested tags:**
`Leaders`, `War Prep`, `Composition`

**Body:**

### Why this matters
Correct composition reduces mismatch risk and improves spin quality.

### Command
`/compo state`

### When to use
- Before spin windows
- After recruit movement between clans
- During final war roster checks

### Steps
1. Run `/compo state` for the target clan.
2. Review current weight profile and missing/excess ranges.
3. Identify whether to move in/out specific weights.
4. Re-run `/compo state` after adjustments to confirm final readiness.

### Success criteria
- Composition aligns with target weight plan
- Leadership has a clear move list before war start

### Leader benefit
- Better planning confidence
- Fewer last-minute mistakes
- Faster decision-making for roster moves

### Screenshot checklist
- Initial `/compo state` output (before adjustments)
- Final `/compo state` output (after adjustments)
- Optional annotated screenshot showing “what changed”

---

## 4) Copy template: Start War + Send FWA Mail

**Title:**
`Start War + Send FWA Mail (Spin Workflow)`

**Suggested tags:**
`Leaders`, `War Spin`, `Mail`

**Body:**

### Why this matters
A clean spin workflow ensures members receive clear instructions and leadership captures match details quickly.

### Commands
- `/tracked clan configure`
- `/fwa mail send`
- `/fwa match <tag>`

### When to use
- At war start / right after spin
- Whenever match details need to be posted clearly

### Steps
1. Confirm clan tracking is healthy (`/tracked clan configure` already done for this clan).
2. Send war instructions using `/fwa mail send`.
3. Fetch/post match details using `/fwa match <tag>`.
4. Confirm members received/acknowledged key instructions in your war channel.

### Success criteria
- Mail sent successfully
- Match details posted and visible
- Members have clear action instructions

### Leader benefit
- Repeatable war start process
- Better member clarity and fewer DMs/questions
- Cleaner documentation of each war cycle

### Screenshot checklist
- Mail command execution and success output
- Match command output (`/fwa match <tag>`)
- Final war channel message where leaders reference both

---

## 5) Copy template: Recruitment Workflow

**Title:**
`Recruitment Workflow (Scripts + Countdown)`

**Suggested tags:**
`Recruiter`, `Leaders`, `Recruitment`

**Body:**

### Why this matters
Standardized recruitment messaging improves conversion and prevents inconsistent instructions.

### Commands
- `/recruitment edit`
- `/recruitment show`
- `/recruitment dashboard`
- `/recruitment countdown start`
- `/recruitment countdown status`

### When to use
- Daily recruiting windows
- Before/after high-volume placement pushes

### Steps
1. Update message/script templates with `/recruitment edit`.
2. Preview with `/recruitment show`.
3. Review pipeline/status with `/recruitment dashboard`.
4. Start timer with `/recruitment countdown start`.
5. Check progress with `/recruitment countdown status`.

### Success criteria
- Script is current and approved
- Recruiters are using one consistent message source
- Countdown status is visible and tracked

### Leader benefit
- Better recruiter coordination
- Clear pacing during time-boxed recruiting
- More predictable handoffs into placement

### Screenshot checklist
- Edited template output
- Dashboard view
- Countdown start + status output

---

## 6) Copy template: Place New Recruits by Weight

**Title:**
`Place New Recruits by Weight (/compo state placement flow)`

**Suggested tags:**
`Recruiter`, `Leaders`, `Placement`

**Body:**

### Why this matters
Fast, accurate placement keeps each clan balanced and avoids overloading one roster band.

### Command
`/compo state`

### When to use
- Immediately after recruit acceptance
- During active balancing before spin

### Steps
1. Run `/compo state` across candidate clans.
2. Compare which clan currently needs that recruit’s weight band.
3. Direct recruit to the best-fit clan.
4. Re-check `/compo state` after placement to validate impact.

### Success criteria
- Recruit placed in the most needed clan
- Overall alliance composition improves (not just one clan)

### Leader benefit
- Better alliance-wide balance
- Less rework/moving people again later
- Faster onboarding for new recruits

### Screenshot checklist
- Side-by-side or sequential `/compo state` outputs from multiple clans
- Final confirmation message to recruit (optional)

---

## 7) Copy template: Troubleshooting + Common Mistakes

**Title:**
`Troubleshooting + Common Mistakes`

**Suggested tags:**
`Leaders`, `Mods`, `Help`

**Body:**

### Top mistakes
1. Running workflows before tracking is configured.
2. Using outdated recruitment script text.
3. Forgetting to re-check composition after moving players.
4. Sending mail without posting match details.

### Quick fixes
- Re-run foundation setup: `/tracked clan configure`
- Validate script: `/recruitment show`
- Re-validate composition: `/compo state`
- Re-post match details: `/fwa match <tag>`

### Escalation note
If outputs look wrong, collect screenshots of command input + bot response and tag leadership support in the help thread.

---

## Screenshot and formatting standards

Use this standard in every post:

- `What this does`
- `When to use`
- `Command(s)`
- `Step-by-step`
- `Success criteria`
- `Common mistakes`
- `Screenshots`

Screenshot guidance:
- Capture full command + full bot response in one image where possible.
- Prefer real outputs over mocked examples.
- Redact player IDs/tags only if required by your policy.
- Keep one “before” and one “after” image for state-changing workflows.

---

## One-post vs many-post answer (recommended decision)

Use **many focused posts + one index post**.

Avoid putting all features into one giant post because:
- It becomes hard to search.
- Updates become messy.
- Leaders skip sections and miss details.

If you still want a single-post option, keep it as a short **“Quickstart cheat sheet”** that links to detailed posts.
