Use this as the regression checklist after `dev -> main`.

**1. Startup**
- deploy `main`
- run `npx prisma migrate deploy`
- start bot
- confirm:
  - no migration errors
  - no missing-column/table errors
  - no Prisma schema mismatch
  - commands register successfully
  - poll loops start once

**2. Database sanity**
Run and confirm:
- `CurrentWar` rows look consistent
- `WarAttacks` contains only current-war data
- `WarLookup` still has recent ended wars
- `WarEvent` has expected `war_ended` rows
- `ClanPostedMessage` exists and has rows
- `ClanPointsSync` exists and rows include `outcome` + `isFwa`
- `ClanWarParticipation` exists and has rows for backfilled/new ended wars

**3. `/fwa match` alliance**
Verify:
- command opens without timeout
- no `Unknown interaction 10062`
- all clans render
- match type badges render correctly
- sync warnings make sense
- no obvious duplicate points-site calls beyond expected
- dropdown “open clan match view” warning icon displays correctly

**4. `/fwa match <tag>` single clan**
Verify:
- command loads without timeout
- single-clan view renders
- “Data is in sync with points.fwafarm” matches reality
- mismatch reasons are correct
- BL/MM + `isFwa=true` shows invalid warning
- sync state is based on `ClanPointsSync`, not old JSON

**5. `/force sync data`**
For one active clan:
- run `/force sync data`
- verify DB updates:
  - `ClanPointsSync.syncNum`
  - `opponentTag`
  - `clanPoints`
  - `opponentPoints`
  - `outcome`
  - `isFwa`
- confirm no writes rely on `TrackedClan.pointsScrape`

**6. Mail flow**
From single-clan `/fwa match`:
- click send mail
- open confirm/send screen
- `Back` button returns correctly to single-clan view
- `confirm and send` posts mail
- `ClanPostedMessage` gets/updates `type='mail'`
- if mail is superseded, existing row updates instead of creating duplicate

**7. Notify downstream refresh**
After sending a new mail for a current war:
- existing notify embed updates downstream
- no duplicate notify post
- confirm tracked row exists in `ClanPostedMessage`:
  - `type='notify'`
  - correct `event`
  - correct `warId`

**8. War event transitions**
Test or observe:
- `notInWar -> preparation`
  - notify post sent
  - `ClanPostedMessage` row created for `war_started`
- `preparation -> inWar`
  - battle-day notify post sent
  - tracked row created/updated
- `inWar -> notInWar`
  - war-end logic runs
  - `WarEvent` idempotency row exists
  - `WarLookup` row written
  - `ClanWarParticipation` rows written
  - `WarAttacks` cleaned for that war

**9. Idempotency / redeploy safety**
During an active war:
- restart/redeploy bot
- verify:
  - no duplicate prep-day notify
  - no duplicate battle-day notify
  - no duplicate war-end notify
  - war mail refresh edits existing message instead of posting new one

**10. `/war history`**
Verify:
- command loads
- recent wars display
- correct match type / outcome / timestamps
- no dependence on removed `pointsScrape`

**11. `/war war-id`**
Test with 2-3 recent valid IDs:
- output works
- CSV/export works if applicable
- payload contains attacks
- no missing-war lookup errors

**12. `/inactive wars`**
Verify:
- command returns data from `ClanWarParticipation`
- no dependence on `WarAttacks`
- works for clans with recoverable history
- warning text appears for partial coverage
- clan hoppers are included historically

**13. `/inactive days`**
Verify:
- still works unchanged
- no regressions from the `/inactive wars` rewrite

**14. Manual poll**
Run:
- `/force poll war-events`
Verify:
- no duplicate event spam
- no missing-warId failures
- no `10062`
- no broken refresh paths

**15. Logging / telemetry**
Watch logs for:
- repeated `war_ended suppressed` spam
- duplicate guard skips where expected
- missing notify tracked message warnings
- `Unknown interaction`
- unexpected spikes in points-site fetches

**16. Performance**
Check:
- `/fwa match` alliance latency is acceptable
- `/fwa match <tag>` latency is acceptable
- poll cycle duration is stable
- no excessive repeated web fetches
- `activity_observe_cycle` still behaves normally

**17. Final DB spot checks**
After all testing:
- newest ended war has `ClanWarParticipation` rows
- newest mail/notify actions have `ClanPostedMessage` rows
- newest sync has `ClanPointsSync.isFwa` populated
- no `TrackedClan.pointsScrape` references remain in schema/runtime

If you want, I can turn this into a copy-paste QA checklist with:
- command to run
- expected result
- DB query to verify each item.