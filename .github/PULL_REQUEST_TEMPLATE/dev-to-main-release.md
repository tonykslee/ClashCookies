## Release Summary
- Release version: `vX.Y.Z`
- Base: `dev` -> `main`
- Objective: Promote vetted staging changes to production

## Included Changes
- Link this section to the release notes format in `docs/release-notes-template.md`.
- Keep entries user-facing and grouped by theme.

## Validation Evidence
- [ ] Changes were tested in staging Discord server
- [ ] Required CI checks passed
- [ ] Railway deployment status is healthy for staging path

## Operational Notes
- Required env var updates in production:
  - `None` or list keys only (no secret values)
- Migration or data changes:
  - `None` or describe

## Post-Merge Steps
- [ ] Sync `dev` to `main` to keep branch history aligned:
  1. `git fetch origin`
  2. `git switch dev`
  3. `git merge --ff-only origin/main`
  4. `git push origin dev`
- [ ] Verify alignment:
  - `git rev-list --left-right --count origin/main...origin/dev`
  - Expected: `0    0`
- [ ] Create GitHub release tag with same notes

