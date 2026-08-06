-- KontextMind 0003_chunk_heading.sql
-- Search hits report the section heading per protocol v0.1.
alter table chunks add column if not exists heading text;
