# Dusk feature screenshots and command spotlights

**Status:** Agreed documentation/process policy; safe fixture/demo generator **proposed, not yet implemented**.  
**Adopted:** 2026-11-17  
**Audience:** Development reviewers, Rising Dawn leaders, members, and monthly Dusk Update editors.

## Purpose

Make it routine to teach people what Dusk does, not just ship commands. Keep approved, reusable, accurate Discord screenshots and practical spotlights beside the GitHub feature history so monthly announcements do not require reconstructing complicated live war/member states. Preserve the supplied [command spotlight template](templates/command-spotlight.md) as the canonical post outline.

## When a feature PR is proposed or updated

For each **new or materially changed user-visible command, menu, embed, image, or guided interaction**, the PR author/Codex provides a *concise screenshot plan* before merge (typically **2–3 captures maximum**):

1. **Primary happy path:** What the audience sees when they invoke the feature normally.
2. **Key alternate state:** The most useful difference (e.g., missing data, an important warning, an unusual composition, an eligibility/permission gate).
3. **Optional expanded view:** One dropdown, drilldown, error, or mobile layout only when meaningfully different.

Include: audience/permission, exact invocation, selected guild/clan context **without private identities**, safe source type (live non-sensitive/isolated fixture), expected visible data, what must be cropped/redacted, and a short one-line caption. If screenshots would be redundant, unsafe, impossible to reproduce without live production changes, or irrelevant to a non-user-facing patch, record **Not applicable / Deferred** with reason. No requirement to block urgent security fixes, incidents, migrations, or backend-only patches on promotional screenshots.

**Pre-merge gate:** provide the screenshot checklist and the reproducible scenario instructions or a justified exception **before code PR merge approval**. Capture and curate the final images on the feature branch when feasible; otherwise link a bounded post-merge documentation follow-up. Do not misrepresent an unmerged branch capture as production proof.

## Stateful demo and capture tooling (future feature, not a functioning command)

For complex combinations of persisted states, prefer a developer-only **offline fixture-driven preview** that executes the *real production formatter/rendering code* with synthetic inputs and produces a capture-ready output (PNG/HTML, or a safe isolated Discord test artifact if truly needed).

**Desired operator experience:** Codex prepares fixtures and a **single CMD-compatible command** to render each prescribed named scenario. No manual war manipulation, data backfills, or elaborate account-clan setup. Standard scenario IDs might be `compo-surplus`, `compo-partial-data`, `link-compo-deficit`, or `base-swap-pending`—**examples only, not currently supported commands**. Never invent a working invocation; Codex must supply an actually implemented, validated command when the fixture feature exists.

The fixture runner must:
- Use deterministic, committed **synthetic** data and the actual shared production render path; label generated output **DEMO / SYNTHETIC** outside or on the artifact when practical, without obscuring the UI being demonstrated.
- Run locally or in an explicitly isolated test environment; **never** connect to production DB/API, alter real clan/sync/war state, issue Duskits, send DMs, post in production, or trigger global `Post to Channel`.
- Avoid adding a publicly available slash command just for screenshots. Any privileged diagnostic command must be strictly developer-only, fail closed, and be reviewed as **code** before merge.
- Make output names deterministic and test multiple states, including UNKNOWN/missing evidence, permissions and mobile legibility. Clearly distinguish authentic Discord capture from a simulated render; never claim a fake state is real.
- Treat user and clan identifiers, Discord mentions, webhook URLs, access tokens, wallet/history, private alerts and moderation details as sensitive. Use placeholders/synthetic names, remove metadata as needed, and inspect the *actual images* for leakage before committing.

## GitHub evidence library

Use this conventional layout for each feature:

```text
docs/feature-showcase/
  README.md
  <feature-slug>/
    README.md
    images/
      01-primary.png
      02-alternate.png
      03-drilldown.png
```

Feature README fields: name and slash command(s); target audience/permissions; relevant PR(s); **implementation merge date**, production deployment/activation status separately; synopsis/use case; command invocations; screenshot checklist and captions; evidence provenance (`real approved capture` / `synthetic fixture`); exact scenario fixture/command or repeatable capture procedure; date/commit the capture reflects; privacy review; accessibility/legibility notes; and spotlight status (`draft`, `ready after production verified`, `published`, or `deferred`). Link the public-safe images with repository-relative Markdown. Prefer optimized PNG/WEBP and a few high-signal images; avoid duplicate huge images, private logs, real member data, or expired URLs.

A screenshot from `dev` proves *appearance of that build*, **not** production deployment or activation. Only advertise a feature as usable in Discord after independent production verification. Revisit the library if later UI changes make images materially inaccurate.

## Public communication flow

1. Build a short [spotlight](templates/command-spotlight.md) from feature README: **who**, **why**, **how**, **what you get**, notes and 1–3 screenshots. Link to `/help` when appropriate, but do not assume users will proactively browse it.
2. At approved release/monthly editorial time, select 1–2 high-value features from the library (not every merged PR). Use [monthly update policy](monthly-dusk-updates.md); **monthly update remains approval-gated**. A future separate cadence for command spotlights is a proposal, not automatic posting authorization.
3. Verify user access, command syntax, permission restrictions and production readiness. Give the owner a complete post, evidence link and preview; require **Approve / Revise / Skip** before publishing. Track the actual Discord message link/time once delivered; no duplicate posts.
4. Avoid exposing unpublished screenshot evidence or private operational details through public announcements. Public Discord uploads should use approved sanitized images only.

## PR reviewer screenshot checklist (copy into PR or Codex review)

- [ ] List user-visible surfaces changed, target audience and permission requirements.
- [ ] Provide 1–3 screenshot scenarios (normal, important alternate, optional expanded), with exact steps or validated local fixture invocation.
- [ ] Mark each image `real` or `synthetic`, and review privacy, labels and Discord/mobile readability.
- [ ] Add/revise the feature showcase README and approved images when feasible, or document a **tracked, owner-visible follow-up** and the reason.
- [ ] Verify screenshot matches actual code, help text, and expected permissions. For a changed feature, flag stale previously published screenshots.
- [ ] Do **not** claim production availability from a dev capture.
- [ ] Maintain normal code PR CI/merge approvals, independently of documentation screenshot policy.

## Maintenance and ownership

The current developer/Codex supplies the plan and capture instructions, minimizing operator work. The user typically captures only where an interactive Discord view is required; Codex curates images, captions, showcase records and PR links. This process applies prospectively and can be backfilled selectively for the most-used commands, rather than demanding a complete historical screenshot archive before further development.

Track the renderer/tooling in [feature backlog](feature-backlog.md). Production release/publishing remains separately approval-gated.
