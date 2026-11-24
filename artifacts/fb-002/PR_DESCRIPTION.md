# FB-002 — Correct production native composition displays

## Summary

- Render one compact native `HEATMAP REF - PROVISIONAL` table when the published native head is valid; retain the legacy table only as the no-native fallback.
- Replace legacy ACTUAL and WAR comparison columns with compact native TH19-through-TH14 and `<=TH13` deltas without appending a second column set.
- Keep native metadata and provisional status outside table cells, preserve blacklist/copy behavior, and suppress misleading legacy comparison warnings when native rendering succeeds.
- Aggregate lower native target bands consistently for collapsed display; unsupported native bands remain `UNKNOWN`.
- Track unresolved weight slots separately from fallback-resolved WAR weights so incomplete rosters do not double-count fallback weights during Auto-Detect projection.

## Regression coverage

The Akatsuki-shaped fixture covers 49 members, seven missing/fallback provenance cases, one vacant slot, one deferred weight, resolved total `7,319,000`, partial native coverage, Auto-Detect selection, and projection missing-slot accounting.

Additional coverage includes supported and unsupported native bands, TH19, ACTUAL raw semantics, WAR, Copy Table, legacy fallback, blacklist mode, and lower-bucket aggregation.

## Validation

- Targeted Vitest: 7 files, 99 tests passed.
- TypeScript: `npx tsc --noEmit --pretty false` passed.
- Targeted ESLint: passed; one pre-existing warning remains in `compoActualStateView.ts`.
- Full `npm test -- --reporter=dot`: 387 files and 6,039 tests passed.
- Full output: `artifacts/fb-002/full-validation.log`.
- Rendered and visually inspected PNG fixtures:
  - `compo-heatmapref-provisional.png`
  - `compo-state-actual-provisional.png`
  - `compo-state-war-provisional.png`

## Safety

No production data, native publication generation, migration, rollback, commit, push, merge, or deployment was performed. Existing legacy fallback and operational recommendation gates remain in place.
