# Current Endo OCapN peer to Thix supervisor

This isolated experiment pairs Thixotrope PR #1220 source based on
`5a40d85326cf94cecf3f34acb703a8681fdbc14a` with an **independent Endo
OCapN peer process** based on current main
`253449eb23a54435c66140dc5dd3b047832382f9`. The peer process loads its
own mainline `@endo/ocapn` and Syrup codec. It imports Thix's private Unix
framing and durable delivery netlayers only as a test transport. The deployed
Endo pet daemon still uses its configured Noise/TCP/CBOR transport; this test
does not exercise or modify that daemon.

With immutable dependencies and the matching Thix release worker/bundles in
both isolated checkouts, run from the Thix checkout root:

```sh
ENDO_PEER_ROOT=/absolute/path/to/current-main-checkout \
  node packages/thixotrope/experiments/endo-thix-peer-smoke.mjs
```

The harness starts a private Thix supervisor and installs one named Far
capability. A trusted harness step reads the temporary registry publication
and gives its secret only to the Endo peer setup. Neither test guest receives
registry or supervisor authority. The Endo peer fetches the named cap over an
OCapN session, then tests a returned nested Far reference, reference identity,
an Endo Far callback held and called by Thix, an async result, a thrown error,
and repeated stateful calls. It retains references while the Thix supervisor
actually restarts and checks count and callback continuity afterward. JSONL
messages only control the two processes and report pass-by-copy results; the
capability calls themselves use the Syrup OCapN wire and the durable delivery
envelope over a private Unix socket.

The first preflight used a mutable `Uint8Array` for the bootstrap Swissnum;
current Endo requires `encodeSwissnum()` to provide frozen bytes. That
serialization error occurred after the wire handshake and was fixed in the
test peer. The successful run may log transient Unix `ENOENT` retries while
the supervisor's socket is absent during restart. Both child processes and
their owned state close after the test. Timing fields separate cold Thix
startup, provisioning plus Endo connection, first call, warm call, and Thix
restart. They are one-host diagnostics under shared load, not benchmarks.
