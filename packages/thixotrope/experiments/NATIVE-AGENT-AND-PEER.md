# Native agent and peer experiments

This experiment is based on Thixotrope PR #1220 checkout
`5a40d85326cf94cecf3f34acb703a8681fdbc14a`. It runs in isolated state.
It does not modify the live Endo daemon or voice service.

Build the checkout with `corepack yarn install --immutable`,
`cargo build --locked --release -p thixotrope-ironhorse-worker`, and
`corepack yarn workspace @endo/thixotrope build:ironhorse-bundles`. The smoke
also works with an exact-revision copy of the release worker binary.

Run `node packages/thixotrope/experiments/native-agent-smoke.mjs` for a real
Ironhorse supervisor with a **scripted model**. The agent loop is the installed
`native-agent-guest.mjs` object in its own vat. It receives only a model facet
an add-tool facet, and a notes facet. The broker, add tool, and notes store are
separate installed vats. The host handles process lifecycle and provides the model facet; it
does not choose actions or call the tool. The tool uses a per-step idempotency
key. The agent stores its turn phase and history in the Ironhorse heap.

`native-agent-driver.mjs` accepts line-delimited JSON requests. Each request
has a numeric `id` for the response and an `op`. Supported operations are:

- `start {statePath?}` starts a private supervisor. An omitted path is owned
  and removed by `close`.
- `provision` installs the model broker, add tool, notes store, and agent.
- `bindModel {model:{kind:"scripted",responses:[...]}}` binds a finite test
  sequence. Actions are `{kind:"tool",name:"add",args:[integer]}`,
  `{kind:"tool",name:"remember",args:[key,string]}`,
  `{kind:"tool",name:"recall",args:[key]}`, or `{kind:"answer",text:"..."}`.
  A scripted action can have `delayMs` for
  cancellation tests.
- `bindModel {model:{kind:"local-http",baseUrl:"http://127.0.0.1:8003",
  model:"default"}}` binds an explicit OpenAI-compatible local model endpoint.
  The driver accepts plain localhost HTTP or the explicit `tinix:8003` local
  model host, without credentials. The host
  sends a JSON-action instruction to `/v1/chat/completions`, then passes the
  parsed action to the guest model facet. The caller chooses the endpoint and
  model. No remote or paid model is configured by default.
  `injectInvalidOnce:true` deliberately substitutes one unsupported action
  before the first real model call. This tests the guest's invalid-action
  feedback and repair path; it is a scripted fault, not a model mistake.
- `run {turnId,prompt,maxSteps?}`, `status {turnId}`, `cancel {turnId}`,
  `toolRead`, `noteRead {key}`, `restart`, and `close` act on the installed objects. Responses
  are `{id,ok,value}` or `{id,ok:false,error:{message}}`; concurrent requests
  can return out of order. `run` returns a bounded turn state and elapsed time.

`maxSteps` is 1–8. The local model request limits output to 4096 tokens, turns
off hidden thinking, and has a 360-second HTTP timeout. Cancellation
marks the guest turn and aborts an active model call. The host cannot safely
infer whether a disconnected call completed, so it does not replay it.
The guest checkpoints a tool action before calling the idempotent tool. A
`waiting-model` checkpoint can request the model again after restart if the
caller explicitly calls `run` again; that can spend another model call.
An invalid model action adds bounded feedback without invoking either tool. A
turn that reaches its step bound is `paused`; the caller can increase
`maxSteps` and call `run` again, including after restart.

`native-agent-local-trial.mjs` is an opt-in local Qwen path. Set
`NATIVE_MODEL_URL` and `NATIVE_MODEL_ID`, then run the script only while the
local model owner reserves the GPU. It runs four ordered repeats of three
tasks: add→remember→recall composition across two capabilities, forced invalid-action recovery followed by a
real model decision, and a one-step pause followed by supervisor restart and
model rebind. It records every cell as pass or fail; it does not assume the
model will choose the requested tool. Set `NATIVE_REPEATS=1` for a quick pilot.

Run `node packages/thixotrope/experiments/native-peer-smoke.mjs` for **two
independent supervisor processes**. Alice sends a live installed capability
through capability mail over `thix-unix` to Bob. Bob installs a probe vat with
that received capability as its one grant. The probe tests a returned nested
capability, proxy identity, callback into Bob, promise resolution, thrown
error, and a counter call. It retains the reference while Alice's supervisor
restarts and calls it again. This is direct OCapN reference traffic between
the two supervisors, not a JSON-value bridge. The JSONL and CLI clients only
set up the peers and record pass-by-copy assertions.

The existing Endo daemon registers `ocapn+noise+tcp` with CBOR in
`packages/daemon/src/networks/ocapn.js`. This Thix checkout's production peer
transport is private same-user `thix-unix` with Syrup and a separate durable
delivery envelope. Its admin socket is a different local protocol. There is
no shared production transport or direct Endo↔Thix reference exchange in this
experiment. The two-supervisor proof does not establish that compatibility.

The smokes print cold startup, provisioning, first operation, warm operation,
and restart durations separately. These one-host observations are diagnostics,
not performance benchmarks. Both scripts close their child processes and
remove owned temporary state after completion.
