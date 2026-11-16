# Automatic sync all-spun announcement

The automatic all-spun announcement is a read-only aggregate over the existing
sync claim rows. `TrackedMessageClaim` remains the current-state owner for each
source or status message; this feature does not add a second claim state owner.

## Behavior

- The source sync post is the canonical root (`referenceId = null`). A status
  post resolves through its `referenceId`.
- Only the latest active sync root for a guild can complete.
- The root's `metadata.clans` is the participating-clan denominator.
- Active claims from the root and active status children are unioned by
  normalized clan tag. Multiple users and multiple posts count once.
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
persists terminal delivery state across restarts. Failed routing, Discord sends,
or delivery-state updates release the reservation. The tracked-message sweep
rechecks bounded active roots once per minute, allowing transient failures to
retry without another reaction.

As with all Discord sends, strict exactly-once external delivery is not claimed
across the crash window between Discord accepting the message and the durable
`SyncEvent` update.

## Observability

See `docs/observability.md` for the bounded `[sync-all-spun]` event contract.
Logs include guild/root/sync/destination identifiers and counts, but no user
claim details or reaction timing. Reactions are not verified war-search or
queue-entry evidence.
