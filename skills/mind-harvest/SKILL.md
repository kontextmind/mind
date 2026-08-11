---
name: mind-harvest
description: Session-end learning extraction for KontextMind. Run at session end / close session / harvest — extracts durable learnings and work state from the session, redacts secrets before any LLM sees them, dedupes against the mind, and files drafts to the right scope (local/project/org). Also captures checkpoints and handoffs.
license: Apache-2.0
metadata:
  workflow: memory-harvest
---

# KontextMind Harvest

On load, include skill context in the first `km_status` call (beacon handshake):
`km_status` with `skill: "mind-harvest"`.

## Two-step extraction (analyze → generate)

**Step 1 — Analyze.** Read the session record (diff, decisions, errors, retries).
Produce a structured analysis: candidate learnings, work-state deltas (worked on X,
unblocked Y, next Z), scope hint per item (local / project / org), and connections
to existing knowledge.

**Step 2 — Generate.** For each surviving candidate:
1. **Gate 1 redaction FIRST**: strip tokens, connection strings, .env blocks, client
   names on the denylist — before anything reaches an LLM or the server. Replace
   with stable markers. When in doubt, redact.
2. **Dedupe**: `km_search` the candidate. If it exists, skip (or note a
   `Superseded by:` update if the truth changed — never silently overwrite).
3. **Classify**: `local` → `.kontextmind/local/` (gitignored). `project`/`org` →
   `km_append` with the classification. Drafts enter the review queue per trust mode.
4. **Work state**: `km_work_update` checkpoint with task_ref + note; if the session
   stops mid-task, `km_handoff_save` with bounded state + typed next_steps.

## Rules

- ADD-only: never delete or rewrite existing knowledge; mark supersession.
- One learning = one fact. No session summaries disguised as learnings.
- Uncertainty stays labeled (`Assumption:`, `Open:`).
- Input minimality: diffs + decisions + errors, never full logs or env dumps.
- Report what was filed where, so the human sees the harvest.
