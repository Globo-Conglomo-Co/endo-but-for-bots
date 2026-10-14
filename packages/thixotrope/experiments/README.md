# Ironhorse eval driver

This experimental JSON-lines driver runs against a real Thixotrope supervisor
and the Rust Ironhorse worker. It is pinned to PR #1220 head
`6026f7d741a0c36c08f872b5479dc68976934eee`.

Build from the repository root:

```sh
corepack yarn install --immutable
cargo build --locked --release -p thixotrope-ironhorse-worker
corepack yarn workspace @endo/thixotrope build:ironhorse-bundles
node packages/thixotrope/experiments/eval-driver-smoke.mjs
```

Start `node packages/thixotrope/experiments/eval-driver.mjs`. Send one JSON
request per line and read one JSON response per line. Every request carries an
`id` and an `op`. Responses have `{id,ok,value}` or
`{id,ok:false,error:{message}}`. Operations are:

- `start {statePath?}`: start a private supervisor. An omitted path creates a
  temporary state directory, removed by `close`.
- `install {name,source,grants?}`: bundle and install a guest module. Source can
  declare `const make = powers => ...`, export `make`, or be a factory expression.
  `grants` maps power names to existing inventory names, for example
  `{store:"candidate-store"}`. The result is `{installed:name}`.
- `install {name,store:true}`: install a separate persistent Far Map fixture
  under that name. It has `get`, `has`, `set`, and `delete` methods.
- `invoke {name,method,args?}`: reacquire a named service through the admin
  OCapN session and call one method. JSON pass-by-copy results are supported.
- `evaluate {source}`: evaluate in the durable default workspace and return its
  display description. Use `install` and `invoke` for callable services.
- `restart`: close the client and supervisor, then start a new supervisor on
  the same state. Calls after restart reacquire service references by name.
- `close`: stop the supervisor and remove owned temporary state.

The driver keeps stdout for JSON responses and sends diagnostics to stderr.
Closing stdin also stops the supervisor. A lost connection leaves an in-flight
call's outcome uncertain; the driver does not replay calls.

The smoke uses the release Rust worker, including its `--lock-state` lease
process and per-vat worker processes with the Ironhorse heap, profile, active
lock, limits, and boot bundles. On this host, the first supervisor start took
roughly two minutes; the restart took tens of seconds. Those observations are
not latency benchmarks. The smoke's owned temporary state was removed and no
Ironhorse or driver child remained after exit.

The admin socket and Thixotrope's peer socket use different local transports.
The peer socket accepts only private, same-user `thix-unix` locations. Its
durable resumption envelope has version 2; this is not a generic OCapN wire
version. The PR also changes `@endo/ocapn` from current `origin/llm`. This
driver proves OCapN calls among Thixotrope vats and across its admin socket;
it does not prove direct capability exchange with an Endo pet daemon or any
other OCapN implementation.
