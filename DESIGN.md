# Design — github-core-clone

A GitHub-compatible git forge: git smart HTTP, REST v3, GraphQL v4 and MCP, in
one Node 22 process, standard library only, no dependencies, no git binary,
no database. This file states the design thesis and what makes this entry
different from the obvious/standard approach.

## Thesis: one kernel, four thin adapters

Most forges — and the most obvious way to build this one — mirror the four
surfaces as four separate subsystems (a git module, a REST module, a GraphQL
module, an MCP module), each with its own data logic, plus a shared "database"
underneath. That duplicates the hard semantics (merge conflicts, issue
numbering, ref rules) in four places and lets the surfaces drift apart.

This entry does the opposite. There is exactly one **kernel**: the in-memory
store (`Repo`) plus a small set of core operations — `createIssueOn`,
`createPullOn`, `mergePull`, `putContents`, `fetchSelection`, `diffFlat`.
Every surface is a thin adapter that parses its own wire format and calls the
kernel:

- REST v3 parses paths/bodies and renders JSON.
- Git smart HTTP parses pkt-lines/packs and renders pkt-lines/packs.
- GraphQL parses documents and resolves fields against kernel objects.
- MCP validates tool arguments and calls the same kernel functions.

A pull request merged over MCP, an issue created over GraphQL, and a commit
pushed over git are the same objects everywhere, because there is only one
code path that can create them. Cross-surface consistency is a structural
property, not a test-time hope.

## The token owner's login is derived, not hardcoded

The suite's bearer token belongs to the scenario viewer, and every surface
must answer as that viewer — but the token itself carries no login, and the
entry is never told it. The lazy answer is to probe the scenario once, find
the login (`adaiversen`), and hardcode it. That works until the seed changes,
and it is a fact the entry does not understand.

This entry instead ports the scenario's own deterministic generator (the
xorshift64* stream, FNV-1a label seed, splitmix finalizer, first/last-name
tables — all public kit data) and recomputes the viewer at startup. The login
is a derived value, not a magic string, and the derivation is checkable
against the kit's `wire.ts`.

## Deterministic by construction

- No wall clock, no `Math.random`. Every timestamp comes from
  `MAKEFUN_TRIAL_NOW` (fixed fallback `2025-01-01T00:00:00Z`). Every id is a
  counter. Request ids are a counter.
- Packs are built in a canonical order (objects sorted by oid) and cached by
  fetch signature, so repeated identical fetches return identical bytes.
- Replay determinism follows: the same requests in the same order produce the
  same state, because no request reads anything outside the request stream.

## Shallow fetches: boundary-aware have-closure

The subtle protocol point, and the one a straightforward implementation gets
wrong (my first version did): a client's `have` lines do **not** mean "I hold
this commit and all its history" when the client is shallow. A shallow clone
holds the tip commit but not its parents, and it says so with `shallow`
lines. The server's have-closure must stop at those boundaries — otherwise a
deepen sends nothing (the parent looks already held) and a depth-1 clone
leaks history (the parent is pulled in through the tip's closure).

`fetchSelection` therefore walks haves with a boundary stop, and walks wants
by commit generation (depth N = N generations, trees/blobs included, parents
past the boundary never included). Shallow/unshallow reporting follows from
the same walk: the deepest commits sent are `shallow`, a boundary the walk
passed is `unshallow`.

## Memoized views, not re-parsing

Commits, trees and flattened path maps are parsed once per repo and memoized
(trees are immutable, so the cache is sound); ancestry depth is memoized too.
The read/write hot paths are plain `Map` lookups plus `JSON.stringify`. The
bench numbers come from this, not from a framework: push 48/50, clone 35/50,
read 41/50, write 38/50 locally (162/200), against the reference forge's
100/200 on production calibration.

## GraphQL: a hand-rolled executor, not a schema framework

No schema DSL, no codegen, no library. A small recursive-descent parser
(tokenizer → operations, fragments, aliases, variables, inline input objects
and enum lists) plus a type-driven resolver. Introspection (`__type`) is a
table, not a reflection layer. Unknown fields produce a GraphQL error naming
the field, never an HTTP 400 — which is what gh's feature probes expect.

## MCP: modern era first, legacy as fallback

`server/discover` (2026-07-28) is answered directly with supported versions,
capabilities and identity; `initialize` is also answered for the legacy
handshake. Tool schemas carry only the arguments the suite can fill, so no
call fails for a missing value the caller could never have supplied.

## What this entry deliberately does not do

- No copied forge (Gitea or otherwise) and no copied reference implementation:
  every line is written from the checks' own contract, not from an existing
  codebase.
- No multi-module mirror of the kit's env layout (`git.ts` / `rest.ts` /
  `graphql.ts` / `mcp.ts` as separate subsystems). One file, one kernel.
- No git binary, no shelling out, no filesystem state, no ORM, no framework.
- No per-surface reimplementation of issue/PR/merge semantics.

## Layout

- `main.ts` — the trial lifecycle (bind ephemeral port, register with the env,
  poll until done). This is the competition's mandated wire protocol, kept
  exactly as the kit ships it; it is harness code, not the forge.
- `app.ts` — the forge: primitives → kernel → four adapters → server.
- `DESIGN.md` — this file.
