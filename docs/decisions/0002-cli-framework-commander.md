# Decision 0002 — CLI framework: Commander

Status: **accepted** (owner directive: "use a CLI framework")

## Context

The kontext CLI grew to the full tool surface (read, write, projects,
intelligence, work context, ops). Hand-rolled flag parsing (`argAfter`)
doesn't scale: no typed options, no generated help, no validation, and every
new command repeats plumbing.

## Decision

**Commander** (`commander` npm package) for `@kontextmind/cli`.

Why Commander over the alternatives:
- Most mature and widely used; stable across Node ≥ 18 and Bun — the CLI
  must run under both (npx and bunx).
- Typed, zero-config, small; subcommands + options + auto-help out of the box.
- No runtime constraints or build-time codegen (unlike oclif/clipanion).

## Consequences

- All commands declare their arguments/options explicitly; unknown flags are
  rejected by the framework instead of silently ignored.
- Help text is framework-generated; the prose help block is retired.
- Server communication is unchanged: every command still goes through the
  native `POST /v1/call` transport (CLI-first; MCP wraps the same dispatch).
