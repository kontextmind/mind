# Trust Modes

Status: **v1**

Strictness is configuration, not code paths. One knob per instance, overridable per
namespace. `kontext init` asks which mode; the server enforces it.

```toml
[trust]
mode = "standard"   # relaxed | standard | strict
```

| Behavior | relaxed (personal) | standard (team, default) | strict (client/employer) |
|---|---|---|---|
| Serve draft content in search | yes, labeled | yes, labeled | **verified only** |
| Harvest promotion | low-risk one-liners auto-promote if all gates pass | human review required | human review + enforced provenance display |
| Inbox writes | direct commit | direct commit + review queue | review queue, max-sensitivity secret gates |
| External source ingest | allowed | allowed | **off by default** |
| Quarantine aggressiveness | lenient | standard | aggressive |
| Workflow insights emission | default budgets | default budgets | halved budgets |

## Definitions

- **Low-risk one-liner**: single-sentence learning, no code blocks, no paths, passes
  both secret gates, dedupe finds no conflict. Anything else requires review.
- **Enforced provenance display**: search hits in strict mode always include status,
  author, commit SHA; the MCP response schema marks these fields required.
- **Max-sensitivity gates**: denylist matching is fail-closed (scan error → quarantine).

## Override rules

- Namespace overrides may only **increase** strictness relative to the instance mode,
  never decrease it (an org admin cannot relax a namespace the instance marked strict).
- Overrides are recorded in `namespaces.trust_override` with author + timestamp.
