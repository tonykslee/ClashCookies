# Dusk Monthly Updates — audience-facing announcement policy and template

**Status:** Agreed publication direction; approval-gated automation is proposed/not implemented in the bot  
**Established:** 2026-11-17  
**Audience:** Rising Dawn members and clan leaders, not a general-FWA promotional launch

## Purpose and cadence

- Publish **one concise, user/leader-facing Dusk update per month** when there are meaningful, *production-verified and actually available* changes.
- **First edition:** Duskits economy launch special, **only after independently verified production launch and actual member availability**. If launch has not happened, prepare a private status/check-in but **do not publish an update claiming Duskits are live**.
- This public update is **not** a deployment log, code changelog, or promise to publish unfinished proposals. Keep the technical patch history in [feature-history.md](feature-history.md); the [feature backlog](feature-backlog.md) contains future work.
- A monthly reminder/draft is useful even if there are no qualified updates; publishing is optional when there is nothing relevant to users.

## Monthly editorial template

The existing Discord GitHub-release workflow parses a section headed exactly `## Highlights`. Keep that heading in any GitHub Release body intended for the *existing* webhook, but verify the audience/destination before use. This human-facing format is separate from the technical [release-notes-template.md](release-notes-template.md).

```markdown
# 🌅 Dusk Monthly Update — {{MONTH YEAR}}
{{SHORT_HEADLINE}}

## Highlights

**✨ {{BIGGEST_NEW_FEATURE}}**
{{ONE_OR_TWO_SENTENCES_ON_BENEFIT_TO_USERS}}
**Try it:** `/{{VERIFIED_COMMAND}}` {{OPTIONAL_ELIGIBILITY_NOTE}}

**🆕 More improvements**
- **{{IMPROVEMENT_1}}:** {{USER_BENEFIT_AND_OPTIONAL_COMMAND}}
- **{{IMPROVEMENT_2}}:** {{USER_BENEFIT_AND_OPTIONAL_COMMAND}}
- **{{IMPROVEMENT_3_IF_WORTH_SHARING}}:** {{USER_BENEFIT}}

**💬 Feedback**
What would make Dusk more useful? Reply in the channel or share feedback with the admin team.
```

Template values must be replaced before publication. Target one headline + 2–4 other highlights, roughly 150–300 words total, mobile-friendly; avoid internal commit hashes, migrations, schema vocabulary, unsupported superlatives, and unnecessary role pings. Mention access restrictions where a feature is leader/admin-only. Never claim a rollout or earnings feature is enabled on the strength of a `dev` merge alone.

## Draft → approve/deny → publish

1. **Collect candidates:** Query [feature-history.md](feature-history.md), merged PRs, production deployment evidence and relevant roadmap. Consider what changed *since the previous actually published monthly update*; avoid announcing the same patch twice. Prefer impact and immediate user action over chronological merge ordering.
2. **Qualify every highlight:** Verify production deployed SHA/image and activation/configuration if necessary; verify user-visible behavior and who has access. Classify unverified, disabled, proposed, or `dev`-only work as **excluded**. For Duskits, consult [dusk-economy.md](roadmaps/dusk-economy.md) and ensure issuance/redemption is actually authorized/operational before advertising it.
3. **Generate preview:** Produce the Markdown above, plus a **private reviewer note** with evidence links, excluded candidates, intended destination(s), whether it would ping roles, and whether prior posts would be duplicated. Do not include the reviewer note in the published copy.
4. **Require explicit human decision:** **Approve**, **Revise**, or **Skip** that specific edition. No timeout/absence of response constitutes approval. Drafting does not send any Discord message, create a published GitHub release, trigger webhooks, deploy code, or grant authority for a future edition.
5. **Publish only on explicit approval:** For the existing release-to-Discord path, first verify that the GitHub Release trigger and BOTH configured DEV/PROD webhook destinations are appropriate (see `.github/workflows/discord-releases.yml`). Publishing a GitHub Release currently triggers Discord webhook posts; do not use it for the monthly edition without reviewing the audience/routing and avoiding duplicate sends. Prefer a distinct, reviewed publishing action with an edition idempotency key if changing the system later.
6. **Verify after publish:** Record the actual timestamp, channel/message link, edition identifier, and GitHub release/PR link when applicable in [feature-history.md](feature-history.md). If webhook post fails or evidence is missing, mark **UNKNOWN** rather than silently retrying and duplicating.
7. **Skip safely:** If user denies/skips or no eligible features are verified, record that decision privately; do not publish an empty or speculative update.

## Feature discovery and screenshots

- Curate candidate announcements from the [feature-showcase library](feature-showcase/README.md) and its [screenshot backlog](feature-showcase/screenshot-backlog.md) in addition to [feature history](feature-history.md). Only use screenshots explicitly marked **Current** after accuracy/privacy review; exclude **Outdated**, **Deprecated**, and uncaptured examples until refreshed. Prefer a short command spotlight with **1–3 privacy-reviewed screenshots** for impactful features; do not add screenshots solely for decoration.
- Reuse the [existing command spotlight standard template](templates/command-spotlight.md) for standalone education posts. Include direct slash-command examples, intended audience, permission/access restrictions, one important example state, and a pointer to `/help` when relevant.
- An approved image captured from synthetic fixtures or `dev` may illustrate the UI but must be accurately labeled. Never claim deployment or earning/issuance from a screenshot; verify availability separately.
- The monthly newsletter and individual spotlights are distinct communications. Neither is auto-published. The owner reviews a complete preview and chooses **Approve / Revise / Skip** for each public post.

## Implementation boundary

- The monthly **reminder/draft** can be scheduled independently; it is not equivalent to a Discord publisher.
- A full automatic approval-to-post handoff requires a separately reviewed GitHub/bot workflow, authenticated approval permissions, one-post-per-edition idempotency, an explicit destination, audit records and safe retry rules. That change is **proposed only** and needs normal code/CI/merge approval.
- No automatic publication, GitHub Release creation, Duskits activation, production deployment, wallet issuance or unauthorized role ping is approved by this policy.
