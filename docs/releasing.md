# Releasing KontextMind

One command:

```bash
bun run release patch      # or minor | major | x.y.z
bun run release patch --dry-run   # preview without touching npm/git
```

The script (scripts/release.mjs) does, in order:

1. Pre-flight — clean tree, on `main`, in sync with origin
2. Bumps **all four** package.json files in lockstep (root, server, cli, serve)
3. Builds both publishable bundles (`cli/dist`, `serve/dist`)
4. Publishes `@kontextmind/cli` and `kontextmind` with `--access public`
5. Commits, tags `vX.Y.Z`, pushes main + tag
6. Cuts the GitHub release with generated notes (edit for prose afterwards)

## Auth

Publishing needs npm credentials with 2FA bypass: a **granular access
token** with "bypass two-factor authentication" checked (stored in the
password manager — never in the repo). Either set it in `~/.npmrc`
(`//registry.npmjs.org/:_authToken=…`) or publish with
`npm publish --userconfig <file>` pointing at one.

## Version discipline

- All packages move together — no skew (the test suite asserts it).
- Protocol surface (`km_*`, trailers, /v1) follows docs/protocol.md:
  additive within a major; breaking changes bump major + migration note.
- Scoped-package propagation can take a few minutes after publish — a fresh
  `npm view` 404 right after a successful publish is normal; wait, don't
  republish.
