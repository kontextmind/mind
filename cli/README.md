# @kontextmind/cli

The CLI for [KontextMind](https://github.com/kontext-mind/mind) — the
persistent mind behind every AI agent: memory + work context + workflow
intelligence, git-canonical and self-hostable.

## Install

```bash
npm install -g @kontextmind/cli   # provides `kontext`
```

Node ≥ 18.17 required (the published bundle is plain ESM; no Bun needed).

## Commands

```bash
kontext init    [--url U] [--token T] [--dir D]  # connect a project:
                                                   # MCP config + commit-msg
                                                   # trailer hook + AGENTS.md
kontext login   [--url U]                        # OAuth login via device code
kontext doctor  [--dir D]                        # verify installation +
                                                   # check for new releases
kontext version                                  # CLI version + release notice
kontext search <query>                           # search the mind
kontext read <path>                              # read one page
kontext status                                   # index freshness + session
kontext append --title T --content C             # file a learning draft
kontext review [list | resolve <id> <verdict>]   # work the review queue
```

Environment: `KM_URL` (MCP endpoint), `KM_TOKEN` (bearer token, demo mode),
`KM_CONFIG_DIR` (token/consent cache), `KM_NO_UPDATE_CHECK=1` (opt out of
release notices).

## What `init` wires into your project

| Artifact | Purpose |
|---|---|
| `.mcp.json` | the `kontextmind` MCP server entry (merged, never clobbered) |
| `.git/hooks/commit-msg` | appends the `KM-Session` evidence trailer from `.kontextmind/session` (fail-open, idempotent) |
| `AGENTS.md` | marker-delimited contract: `km_*` usage, beacon handshake, trailer duty |
| `.kontextmind/kontext.json` | manifest (URL, CLI version, install date) |

Re-running `init` is safe and updates hook + contract in place — that's the
upgrade path when a new release lands (`kontext doctor` tells you when).
