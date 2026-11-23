# FB-002 P4d-1b Observation Migration Recovery

The P4d-1b persistence change is additive and ordered:

1. `20261123120000_add_fwa_war_members_observations` creates the semantic observation and member tables.
2. `20261123130000_add_fwa_war_members_observation_evidence` creates immutable source-quality revision history beneath those observations.

If deployment stops after either migration:

- Preserve the database and inspect the exact migration status with the normal Prisma migration tooling.
- Resolve the deployment or schema-compatibility cause, then rerun `prisma migrate deploy` so the recorded migration state can move forward idempotently.
- Verify the parent/member/evidence foreign keys, unique constraints, and representative application reads after recovery.
- If application code must be rolled back to an older commit, treat that as a code rollback only. It does not reverse PostgreSQL migrations that already committed, and the older code may simply ignore these additive tables.
- Do not delete migration records, edit historical migration files, or run an automatic destructive SQL rollback. Any exceptional manual migration-state repair requires the repository's normal owner-approved release procedure.

The migrations do not alter or delete existing current-state rows. This recovery note is operational guidance only; it does not activate native publication, TH19 targets, a collector, or a scheduler.
