# github-core-clone

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/feza992/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/feza992/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in one Node 22 process, standard library only: git smart HTTP (upload-pack v2/v0, receive-pack), REST v3, GraphQL v4 and MCP over a single in-memory kernel — one code path creates every object, so a commit pushed over git, an issue created over GraphQL and a pull request merged over MCP are the same objects everywhere.

## Run it

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:8080 MAKEFUN_SHOP_TOKEN=$MAKEFUN_SHOP_TOKEN node main.ts
```

The entry binds an ephemeral port, registers it with the env at `$MAKEFUN_ENV_URL`, serves until the env says done, then exits 0. `GET /healthz` answers `{"ok": true}` with no token; every API call needs `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`.

---

<sub>Entered on [make.fun](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>

## Design

See [`DESIGN.md`](DESIGN.md) for the architecture and what makes this entry different: one kernel with four thin adapters, the token owner's login derived from the scenario seed instead of hardcoded, boundary-aware shallow fetches, and memoized views instead of re-parsing.

## What it serves

- **Git smart HTTP** at `/{owner}/{repo}.git`: `info/refs`, `git-upload-pack` (protocol v2 with `ls-refs`/`fetch`, plus v0), `git-receive-pack` with fast-forward enforcement and per-ref `report-status`. SHA-1 objects, plain packfiles, sideband framing, shallow/deepen support.
- **REST v3** under `/api/v3`: repos, branches, commits, contents, labels, issues, comments, pull requests with squash merge and conflict detection (`405`), cursor `Link` pagination, `X-GitHub-Request-Id` on every reply.
- **GraphQL v4** at `/api/graphql`: `viewer`, `repository`, `node(id:)`, `__type` introspection, issue/PR reads and mutations, cursor pagination, operation batching.
- **MCP** at `/mcp`: `server/discover` (2026-07-28) plus the legacy `initialize` handshake, `tools/list` and `tools/call` for `create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`.

## License

MIT — see `LICENSE`.
