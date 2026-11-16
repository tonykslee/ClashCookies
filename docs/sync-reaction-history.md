# Sync Reaction History

`SyncReactionHistory` is the immutable evidence table for sync spin reaction state transitions. It supports future timing and leaderboard analytics without changing current-state ownership.

## Ownership and identity

- `TrackedMessageClaim` remains the sole owner of whether a user currently claims a clan on a specific source or status post.
- `SyncReactionHistory` records only accepted absent-to-present ADD and present-to-absent REMOVE transitions.
- Each row preserves the canonical root tracked/message identity, the actual source/status tracked/message identity, guild, Discord user, normalized clan tag, action, validated metadata `syncTime`, explicit bot-observed `observedAt`, an explicit `observationPhase` (`PRE_SYNC` or `POST_SYNC`), and database-generated `eventOrder`.
- The history table intentionally has no foreign key to `TrackedMessage`; expiry, replacement, deletion, or claim cleanup cannot cascade-delete historical evidence.

## Transaction and fail-closed rules

Reaction validation, current-state mutation, and history insertion run in one database transaction. Duplicate ADD/REMOVE deliveries do not append rows. Concurrent duplicate ADDs rely on the current-claim unique key; a conflicting unique result is treated as the other transaction having won and does not invent an event. A history write failure rolls back the claim mutation.

The exact sync time comes only from validated root metadata (`syncTimeIso` plus matching epoch seconds). Expired, malformed, stale, replaced, or unresolved roots and invalid clan identities are ignored. Valid pre-sync reactions remain current-state compatible and are recorded with their actual bot-observed time as `PRE_SYNC`; M1 all-spun delivery remains post-boundary only. No historical backfill is performed. Mirror runtimes do not create new historical evidence through this flow.

`observedAt` is when the bot accepted the event, not when a player entered a Clash search queue. `eventOrder` is a PostgreSQL sequence allocation order only; it is not commit order, append/visibility order, or a reliable wall-clock ordering under concurrent transactions. Future analytics must use `observedAt` and `observationPhase` conservatively, and classify contradictory, tied, or out-of-order evidence as UNKNOWN rather than silently treating reaction timing as verified game evidence.
