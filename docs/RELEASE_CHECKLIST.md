# Release Checklist

Use this for each release promotion from `dev` to `main`.

## 1. Pre-PR Gate (dev is ready)
- [ ] Feature/fix PRs into `dev` are merged
- [ ] Staging behavior is validated
- [ ] Any required docs updates are merged in `dev`
- [ ] Release notes drafted using `docs/release-notes-template.md`

## 2. Create PR (`dev` -> `main`)
- [ ] Open PR from `dev` to `main`
- [ ] Choose template: `dev-to-main-release.md`
- [ ] Paste final release notes content
- [ ] Confirm CI checks are passing

## 3. Merge and Tag
- [ ] Merge PR to `main`
- [ ] Create release tag (example: `v1.4.3`)
- [ ] Use the same release notes as PR

## 4. Keep Branches Aligned (target: 0 0)
- [ ] Run:
  1. `git fetch origin`
  2. `git switch dev`
  3. `git merge --ff-only origin/main`
  4. `git push origin dev`
- [ ] Verify:
  - `git rev-list --left-right --count origin/main...origin/dev`
  - Expected: `0    0`

## 5. Post-Release Quick Audit
- [ ] Production deploy status is green
- [ ] Bot health checks look normal
- [ ] No permission warnings/regressions in logs

