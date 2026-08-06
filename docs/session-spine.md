# Agent Evidence Trailers v1

Status: **v1 (frozen — changes require version bump)** · the `KM-Session` commit-trailer spec

The trust anchor of KontextMind's Workflow Intelligence is a join key between agent
sessions and git history that agents can omit but cannot fake.

## Format

Every commit produced by an agent session SHOULD carry a git trailer:

```
KM-Session: km_ses_<26-char-ulid>
```

- Session IDs are issued by the KontextMind server at first authenticated MCP call
  of the session (format `km_ses_` + ULID).
- Multiple sessions may touch one commit: repeat the trailer per session.
- The trailer value MUST be a session ID that exists on the server; unknown IDs are
  recorded as `unresolved` and surfaced in coverage metrics (never silently dropped).

## Emission

1. **Commit-msg hook** (shipped by `kontext init` into the AGENTS.md contract of each
   project): reads the active session ID from `.kontextmind/session` (written by the
   MCP handshake) and appends the trailer.
2. Agents/harnesses MAY emit the trailer directly when they control commit creation.

## Server-side join

On GitHub webhook events (push, PR, check_suite, merge):

1. Parse trailers from new commits.
2. Join to `km_event`/session records → populate `git_evidence(session_id, repo, sha,
   pr_number, ci_status, first_green_at, rework_commits, merged_at)`.
3. `git_evidence` is populated **only from webhooks** — never from agent self-report.

## Integrity rules

- A session may claim commits only in repos its namespaces cover (checked at join time).
- Trailer presence is optional; trailer forgery is impossible (unknown IDs don't resolve).
- Coverage metric: % of merged agent-authored commits carrying a resolvable trailer,
  per agent identity. Low coverage = instrumentation gap, surfaced on the dashboard.

## Emitter compatibility

Any tool that creates commits can emit this trailer. KontextMind aims to ship emitters
for: Claude Code, Codex, Grok CLI, Kimi, Gemini CLI, opencode, Cursor. Third-party
emitters are encouraged — this spec is the ecosystem surface.
