# Sync Reaction History

`SyncReactionHistory` is the immutable evidence table for sync spin reaction state transitions. It supports future timing and leaderboard analytics without changing current-state ownership.

## Ownership and identity

- `TrackedMessageClaim` remains the sole owner of whether a user currently claims a clan on a specific source or status post.
- `SyncReactionHistory` records only accepted absent-to-present ADD and present-to-absent REMOVE transitions.
- Each row preserves the canonical root tracked/message identity, the actual source/status tracked/message identity, guild, Discord user, normalized clan tag, action, validated metadata `syncTime`, explicit bot-observed `observedAt`, and database-generated `eventOrder`.
- The history table intentionally has no foreign key to `TrackedMessage`; expiry, replacement, deletion, or claim cleanup cannot cascade-delete historical evidence.

## Transaction and fail-closed rules

Reaction validation, current-state mutation, and history insertion run in one database transaction. Duplicate ADD/REMOVE deliveries do not append rows. Concurrent duplicate ADDs rely on the current-claim unique key; a conflicting unique result is treated as the other transaction having won and does not invent an event. A history write failure rolls back the claim mutation.

The exact sync time comes only from validated root metadata (`syncTimeIso` plus matching epoch seconds). Expired, malformed, future, stale, replaced, or unresolved roots and invalid clan identities are ignored. No historical backfill is performed. Mirror runtimes do not create new historical evidence through this flow.

`observedAt` is when the bot accepted the event, not when a player entered a Clash search queue. `eventOrder` is the database append sequence and must be kept separate from wall-clock timing. Future analytics must classify contradictory or out-of-order evidence as UNKNOWN rather than silently treating reaction timing as verified game evidence.
