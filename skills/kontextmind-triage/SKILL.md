---
name: kontextmind-triage
description: Work the KontextMind review queue — promote harvested learnings, resolve drift/contradiction/gap items, dismiss noise with reasons. Use when asked to triage the mind, review the queue, or promote learnings.
license: Apache-2.0
metadata:
  workflow: memory-triage
---

# KontextMind Triage

On load, include skill context in the first `km_status` call (beacon handshake):
`km_status` with `skill: "kontextmind-triage"`.

## Workflow

1. `km_review action=list` — group by kind: learning, drift, contradiction, gap,
   loop, suspicious.
2. **Suspicious first**: items that tripped a secret gate get resolved before
   anything else. Never paste the matched secret; reference the rule only.
3. For each item, choose the constrained action:
   - `promote` — content is true, scoped correctly, deduped; server commits it to
     curated pages directly (no PR ceremony).
   - `research` — needs evidence; note what's missing.
   - `skip` — noise; mandatory reason code (duplicate, wrong-scope, low-value,
     false-positive).
4. Drift items: verify against the repo HEAD before promoting a fix; the probe
   evidence (`doc_claims`) shows exactly what broke.
5. Loop/gap items that get promoted become artifacts — the insight's `promoted_to`
   must point at the resulting page or skill. Insights compound into knowledge.
6. Dismissal discipline: three dismissals of the same insight type mutes it for
   30 days (visible mute). Don't dismiss what you haven't read.

## Rules

- Every verdict carries a reason. No silent skips.
- Promotion is a trust act: in strict namespaces show provenance (author, source
  session, SHA) to the human before promoting.
