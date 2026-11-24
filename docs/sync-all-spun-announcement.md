# Automatic sync all-spun announcement

The automatic all-spun announcement is a read-only aggregate over the existing
sync claim rows. `TrackedMessageClaim` remains the current-state owner for each
source or status message; this feature does not add a second claim state owner.

## Behavior

- The source sync post is the canonical root (`referenceId = null`). A status
  post resolves through its `referenceId`.
- Only the latest active sync root for a guild can complete.
- The root's complete `metadata.clans` participant snapshot is the
  participating-clan denominator. Missing, malformed, duplicate, or
  contradictory entries invalidate the snapshot; the parser never reduces it
  to a smaller valid list.
- Active claims from the root and active status children are unioned by
  normalized clan tag. A child must belong to the same guild/root and carry
  the same sync identity and participant snapshot before its claims are
  eligible. Multiple users and multiple posts count once.
- Spin Status uses the same validated root/status claim union, so its visible
  count and clan lines do not disagree with announcement eligibility. Reminder
  DMs retain their existing per-user aggregation and wording.
- The announcement is sent only after the exact metadata sync time, and only
  when the root, metadata, expiration, and destination checks succeed.
- The message content is exactly `all spun` and uses the configured typed
  `sync` destination. It does not fan out to per-clan `CLAN_LEAD` channels.
- Mirror, staging, development, and unknown runtime environments do not send.

## Delivery and recovery

Delivery uses `SyncEvent` with the identity:

```text
guildId + exact syncTime + empty clanTag + sync_all_spun:announcement
```

The existing reservation lease suppresses normal concurrent attempts and
persists terminal delivery state across restarts. After claiming, delivery
revalidates the canonical root and complete participant coverage after routing
lookups and again immediately before the Discord send. A changed participant
snapshot or incomplete current claim set releases the reservation. Failed
routing, Discord sends, or delivery-state updates also release the reservation.
The tracked-message sweep rechecks bounded active roots once per minute,
allowing transient failures to retry without another reaction.

As with all Discord sends, strict exactly-once external delivery is not claimed
across the crash window between Discord accepting the message and the durable
`SyncEvent` update. A claim can also change after the final database read but
before Discord accepts the send; that unavoidable cross-system race is not
treated as exactly-once evidence.

## Observability

See `docs/observability.md` for the bounded `[sync-all-spun]` event contract.
Logs include guild/root/sync/destination identifiers and counts, but no user
claim details or reaction timing. Incomplete evaluations include the distinct
claimed/participating counts and the bounded count of rejected child identities.
Reactions are not verified war-search or queue-entry evidence.
