# Native URI globals follow-up

This isolated follow-up starts from the Thixotrope PR #1220 native experiment
branch, after the Endo–Thix direct-peer experiment. It is **not** part of the
frozen `5a40d853` comparison runtime. The change adds four ECMAScript URI
globals directly to the Rust Ironhorse VM. No ambient host I/O or granted
capability implements them.

Run `cargo test -p ironhorse-vm --test uri_intrinsics` from `rust/engine`. It exercises
guest JavaScript, including UTF-8 percent encoding, URI reserved-character
preservation, lone UTF-16 surrogates, malformed escapes, invalid UTF-8, and
catchable realm-local `URIError`s. Run the `uri-intrinsics-smoke.mjs` experiment
with Node from the repository root to check the same behavior through a private supervisor, actual Ironhorse
worker, application installation, and supervisor restart. The smoke owns and
removes its temporary state.

The follow-up admission change reads input code units directly from the guest
string chunk, charging each read, then checks the host meter and heap ceiling
before each encoded or decoded output expansion. It avoids a full temporary
copy of a large input string. The large-input regression prepares
its input in a prior guest crank, then arms a low budget for the URI call. It
must halt near that budget without allocating a result string. The same test
would return from the original URI implementation after doing all the work.

Build the matching worker with `cargo build -p thixotrope-ironhorse-worker --release --locked`
from the repository root, then run `yarn build:ironhorse-bundles` in
`packages/thixotrope` before running the supervisor smoke. This change does not claim a complete Web API or browser intrinsic
surface; it only adds the four URI functions.
