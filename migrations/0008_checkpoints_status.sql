-- KontextMind 0008_checkpoints_status.sql
-- km_work_update carries an optional task status (docs/protocol.md). The
-- phase-0 checkpoints table has no column for it; add it nullable (a
-- checkpoint without a status update is the common case).

alter table checkpoints add column if not exists status text;
