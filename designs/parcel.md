# Parcel: A Primitive for Dormant Capabilities

| | |
|---|---|
| **Created** | 2026-10-14 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Proposed |

## Status

This is a proposal.
Nothing is built here.
It renames and reshapes the in-flight SturdyRef layering stack
([#695](https://github.com/endojs/endo-but-for-bots/pull/695#issuecomment-5903472512),
tracking issue [kriscendobot/garden#47](https://github.com/kriscendobot/garden/issues/47))
and reconciles it with
[`sturdyref-shim-contract.md`](https://github.com/endojs/endo-but-for-bots/pull/1389)
(layer 1, draft PR #1389).
An earlier draft of this argument was circulated as an essay, "Passing Parcels".
That draft was written against the `llm` tip and wrongly described `@endo/ocapn`'s private side table as the open problem.
The stack already addresses that, so this document starts from the stack as it stands.

## What is the Problem Being Solved?

Programs need a third kind of reference.

- A **live** reference is a Remotable, a Promise, or a presence.
  It has identity, and it lasts only as long as the session that carries it.
- A **data** reference is a string, a record, or some bytes.
  It lasts, and it can be copied and logged, but it has no authority and no marker that says it is special.
- A **dormant** reference names a capability without manifesting it.
  It survives partition, restart, and storage.
  It can be woken once or many times by someone who can reach the peer that vouches for it.
  Neither of the other two kinds can be this, and the codebase keeps approximating it with whichever is nearest.

E called the dormant kind a SturdyRef.
"Sturdy" names one property, durability, and not what the thing is.
The word has since spread over three different things:

| People say "sturdyref" and mean | What it is |
|---|---|
| the bytes of an `ocapn://…/s/…` URI | a **locator**: data, copyable, dangerous to leak |
| the object a program holds and passes | a **box** around a locator, opaque, with a way to open it |
| the capability obtained after fetching | a **target**: a live reference with a different lifetime |

Arguments about one then get settled with facts about another.
This repository shows the diffusion.
`@endo/ocapn` calls the box a SturdyRef and the locator a "secret".
The daemon calls nearly the same idea a locator or a formula.
The retention designs call a SturdyRef an "inert data box", which is the best description in the pile and does not appear in the name.

This design proposes the name **Parcel** for the box, and proposes the changes to the stack's contract that the name makes visible.

## Design

### Surface

```js
const parcel = new Parcel(location, open);
// location: string
// open: (location: string, parcel: Parcel) => Passable | Promise<Passable>

passStyleOf(parcel);        // 'parcel'
Parcel.open(parcel);        // Promise<Passable>
Parcel.isParcel(value);     // boolean, a brand check that confers no authority
Parcel.locate(parcel);      // string, present on %InitialParcel% only
```

- `new Parcel(location, open)` requires a string `location` and a function `open`, and throws `TypeError` otherwise.
  It throws without `new`, as `Proxy` does.
  It returns a fresh frozen object with no own properties, inheriting from a hardened `Parcel.prototype` that carries only `constructor` and `Symbol.toStringTag: 'Parcel'`.
  The location and hook live in a closely held `WeakMap` inside the realm's single constructor.
  They are not reachable from the parcel.
- `Parcel.open(parcel)` returns a promise.
  The hook runs in a later turn, as `open.call(undefined, location, parcel)`, and the promise resolves with its result.
  A hook that throws rejects the promise.
  A non-parcel argument rejects with a `TypeError` whose message begins `Parcel.open: not a Parcel`; it does not throw synchronously.
  Each call dispatches afresh and runs the hook again.
  The hook owns idempotence.
- `Parcel.isParcel(value)` consults the `WeakMap`.
  It must not be collapsed into `instanceof`, because a prototype chain can be forged with `Object.create`.
- `Parcel.locate(parcel)` returns the location string.
  It exists only on `%InitialParcel%` (below).

The `open` hook receives the parcel as a second argument so that one hook function can serve many parcels and still apply identity-keyed policy.

### Semantics

| Property | Parcel |
|---|---|
| Pass style | the string `'parcel'` |
| Equality | no pass-invariant equality, like a Promise. Two parcels for one capability may be unequal. |
| Opening | opening twice need not yield the same referent, especially if the referent is a target |
| Partition | a parcel survives it and can reestablish a connection to the capability across sessions |
| Matching a grant | a parcel cannot be used to match a grant; it asserts nothing about identity |
| Confinement | holding a parcel does not reveal where it points; reading the location is a separate authority |

The last row is the reason for the authority split below.
A location carries the cryptographic information needed to establish a session and use the capability directly.
Showing it to a confined principal, even indirectly through a bot's transcript, hands over an exfiltratable key.
A parcel lets a confined principal carry, store, and open a reference without being able to read it.

### Authority split: `%InitialParcel%` and `%SharedParcel%`

SES already splits `Date`, `Symbol`, and `URL` into a powered start-compartment constructor and a powerless shared one, and `Parcel` follows the same pattern.

- `%InitialParcel%` is `globalThis.Parcel` in the start compartment.
  It has the constructor, `open`, `isParcel`, and `locate`.
  Endowing it confers the authority to read the cryptographic information in a location.
- `%SharedParcel%` is `Parcel` in every later compartment.
  It has the constructor, `open`, and `isParcel`, but not `locate`.
  A guest can build a parcel from a location it already holds and can open any parcel it is given, but it cannot learn what a parcel says.
- Both share one `Parcel.prototype`, so `instanceof` and the brand check agree across the boundary.
- `lockdown()` hardens both.
  The `initialGlobalPropertyNames` loop in `packages/ses/src/lockdown.js` already hardens start-compartment globals; the shared constructor is hardened with the other shared intrinsics.

The shared constructor is derived from the initial one using only its public surface, as `%SharedURL%` is in `packages/ses/src/tame-url-constructor.js`.
SES therefore needs no access to the shim's table.

```js
const SharedParcel = function Parcel(location, open) {
  if (new.target === undefined) throw TypeError('Parcel requires new');
  return construct(InitialParcel, [location, open], new.target);
};
defineProperties(SharedParcel, {
  prototype: { value: InitialParcel.prototype },
  open: { value: InitialParcel.open },
  isParcel: { value: InitialParcel.isParcel },
});
```

Permits gain `Parcel: '%InitialParcel%'` in `initialGlobalPropertyNames`, `Parcel: '%SharedParcel%'` in `sharedGlobalPropertyNames`, and entries for both constructors and the shared prototype.
An absent `Parcel` is not an error, so hosts that never installed the shim keep working.

### Packaging

The packaging decisions of layer 1 carry over unchanged.

- A ponyfill (`index.js`) and an installing entry (`shim.js`).
- First definer wins.
  `selectParcel` adopts an existing valid `globalThis.Parcel` (a function with `open`, `isParcel`, and `locate` statics) and installs its own only if none exists.
  Eval twins therefore share one constructor and one table.
- The shim must run before `lockdown()` so that SES sees `Parcel` at `repairIntrinsics` time.
- Before `lockdown()` the shim must not call `@endo/harden`, because that installs a harden implementation and `lockdown` then throws.
  It freezes the constructor, prototype, and statics, and leaves hardening to `lockdown`.
- The shim does not depend on `@endo/pass-style`.
  Pass style recognizes parcels, not the reverse.

### Pass style

`@endo/pass-style` gains `'parcel'` as a `PassStyle`, with a `ParcelHelper` whose `confirmCanBeValid` is `Parcel.isParcel(candidate)` when `Parcel` is defined.
The helper is registered ahead of the remotable helper, because a parcel is frozen with no own properties and would otherwise be rejected as an object with no methods.
`Parcel.prototype` must not carry a `PASS_STYLE` tag.
The brand check is the only recognition path.

### Marshal

Marshal represents a parcel as a slot of a distinct kind, alongside remotable and promise slots, in each encoding.
The location is not part of the encoding unless the marshal's owner holds `locate`.
This is layer 4 of the stack and keeps its content from the existing plan.
Non-OCapN CapTP transports are an open question below.

### CapTP and OCapN

OCapN is trusted code that is endowed `%InitialParcel%`.

- On send, OCapN reads `Parcel.locate(parcel)`, parses the location, and writes the existing `ocapn-sturdyref` wire record carrying the peer and swiss number.
- On receive, OCapN builds `new Parcel(formatLocation(peer, swissNum), open)` with an `open` hook bound to the receiving client, and hardens the result.
  The hook establishes or reuses a session to the designated peer, fetches through the bootstrap, and returns the promise for the referent.
- The **wire tag `ocapn-sturdyref` does not change.**
  It is defined by the OCapN specification and is how Goblins and other peers interoperate.
  Only the JavaScript-facing name and object model change.
  Whether the specification's prose should adopt the word "parcel" is a separate decision and is not required here.

Because every OCapN instance in the process shares one constructor, a parcel built by one instance can be located, serialized, and opened by another.
Under the layer-1 contract, only the minting CapTP could serialize a ref, because only it held the table, and carrying a ref through a second CapTP was left as a protocol-compatibility question.
`locate` on the initial constructor is what lets a trusted forwarder carry a parcel that it did not mint, while a confined guest still cannot read it.

### Provenance

Layer 1's provenance analysis survives intact.
Once `Parcel` is propagated to child compartments, a guest can call `new Parcel(location, evilOpen)`, and the result passes `Parcel.isParcel`.
If a host enlivens such a parcel, the guest's hook runs in the host's turn.
The brand check proves "built by this realm's constructor", never "built by a party I trust".

`locate` adds one consequence.
A trusted forwarder that locates and transmits a guest-forged parcel transmits only the location string the guest chose, not the guest's hook, and a recipient reconstructs its own hook.
That is safe for the sender and is the intended behavior.
The recipient's own `open` hook for a given location scheme is its authority to interpret the string.

The rule for callers is unchanged.
Opening a parcel runs its minter's code, so open only parcels from a source that you would let run code in your turn.
Provenance for parcels that cross a trust boundary belongs to the layer that accepts them: the CapTP at layer 5 and the daemon at layer 8.

### Relation to Proxy and HandledPromise

`Proxy` lets a program supply behavior for the operations on an object.
`HandledPromise` lets a program supply behavior for the eventual operations on a promise.
`Parcel` lets a program supply behavior for acquisition, the step from a dormant name to a live reference.
All three bind a hook at construction that cannot be inspected from the language, and what each object means depends on the trusted code that installed the hook.
That shared shape is why the shim follows the `HandledPromise` pattern, and why the state that must be shared lives in a first-wins global.

### What a Parcel is for

- **Distributed confinement.**
  A confined guest can store, return, and open a parcel without reading it.
  A bot's transcript that handles a parcel contains `Parcel {}` and nothing more.
- **Durable capabilities.**
  A parcel stored today can be opened by a process that has never spoken to the peer, for as long as the peer honors it.
  Opening promises no convergence, so the peer remains free to hand out a fresh attenuated facet each time, or to refuse.
- **Formulas without manifestation.**
  A parcel whose hook runs a formula describes how to obtain a capability and causes none of the effects of obtaining it.
  Builder-pattern APIs can compose such descriptions out of parcels, and the single `Parcel.open` is where cost is incurred and authority exercised.
  This is layer 8's "SturdyRef for a formula without incarnation".

## Reconciliation with the Layer-1 Contract

| Topic | Layer-1 contract (#1389) | This design | Why |
|---|---|---|---|
| Name | `SturdyRef` | `Parcel` | the old name describes durability, not the object |
| Construction | `new SturdyRef(handler, locator)` | `new Parcel(location, open)` | a handler object with one hook is a single function. A shared hook is a shared function. |
| Revive | `SturdyRef.enliven(ref)` | `Parcel.open(parcel)` | "open" matches the box; "enliven" implies the referent is a live thing awakened, which it may not be |
| Eventual-send spelling | `E.enliven` adopted | open question | the precedent of `E.resolve` argues for keeping a convenience spelling, but it adds an `@endo/eventual-send` dependency on the shim's name |
| Hook timing | later turn | later turn, unchanged | an `async` function body runs synchronously until its first `await`, so the implementation must defer explicitly |
| Hook call form | `enliven.call(handler, ref, locator)` | `open.call(undefined, location, parcel)` | no handler object, so no receiver |
| Location access | locator never reachable; only the minting CapTP's side table serializes | `Parcel.locate` on `%InitialParcel%` only | lets a trusted forwarder serialize parcels it did not mint, while guests cannot read them |
| Authority | one constructor; propagation decided by layer 2 | initial and shared constructors | the missing powerless variant is what layer 2's propagation decision needs |
| Brand check | `SturdyRef.isSturdyRef` | `Parcel.isParcel` | unchanged in kind |
| First-wins packaging, harden-if-present, no pass-style dependency | as described | unchanged | settled by layer 1 |
| Provenance | section in layer 1 | carried over, with the `locate` note above | |

## The Layer Map After the Rename

1. `Parcel` shim contract (#1389, #774).
2. SES: permits, `tame-parcel-constructor`, propagate `%SharedParcel%` (#1391).
3. Pass style: `'parcel'` (#1392).
4. Marshal: a slot kind per encoding (#1393).
5. CapTP: mint parcels and carry them on the wire; OCapN supplies the hook and reads `locate` (#1394).
6. CapTP: construct a parcel from data (#1396).
7. OCapN: open through the bootstrap and nonce locator (#1397).
8. Daemon: a parcel for a formula, without incarnating it (#1398).
9. Agent API (#1399, #695, #871).

The retention and revocation questions in [`sturdy-refs-endor-syscall.md`](sturdy-refs-endor-syscall.md) (who keeps a parcel alive in a worker, and how the user revokes it) are unchanged by the rename and remain inputs to layer 8.

## Objections

- **It is just a string.**
  A string is copyable by whatever touches it, prints by default, and is indistinguishable from other strings.
  A parcel prints as an empty frozen object, has its own pass style, and keeps its location behind an authority.
- **It is just a tagged record.**
  Any code can call `makeTagged('ocapn-sturdyref', …)`.
  A pass style backed by a shared brand makes the distinction real and process-wide.
- **Renaming breaks OCapN interop.**
  The wire tag stays.
- **Why not a Remotable with an `open` method?**
  A Remotable is a live target.
  It must be hosted, it has identity, and it dies with its session.
  A dormant capability needs none of those to exist, and hosting it would keep it alive.
- **The metaphor is imperfect.**
  A paper parcel is opened once.
  A Parcel may be opened again and may yield something different.
  The name is chosen for the properties that are most often misunderstood: boxed, addressed, not yet manifest, carried by hands that cannot see inside.

## Open questions

1. Is `Parcel.locate` on the initial constructor an acceptable replacement for layer 1's choice that no location is ever readable?
   It is what lets a trusted forwarder serialize a parcel it did not mint, and it is the one new authority this design adds.
2. Should the OCapN specification's prose adopt "parcel", or should the JavaScript-facing name diverge from the specification's "sturdyref" indefinitely?
3. Package name: `@endo/parcel`, or keep `@endo/sturdyref` for the shim and rename only the exports?
4. Keep `E.enliven` under a new name, such as `E.open`, or drop the eventual-send spelling?
5. How does `@endo/marshal` encode a parcel for non-OCapN CapTP, where there is no `ocapn-sturdyref` record to reuse?
6. What does a second shim of a different version do when it finds `globalThis.Parcel` already installed?
   Layer 1 proposed a `contract` marker in the shape check if semantics ever change.
7. Does `Parcel.locate` throw or return `undefined` for a non-parcel?
   This design assumes it throws, matching `Parcel.open` rejecting.

## Prompt

> I mean to introduce a language feature called Parcel which has some design properties related to Proxy and HandledPromise.
> There would be different Parcel globals in a SES initial compartment and subsequent Compartments, such that the initial Parcel would implement `new Parcel(location, openHook)`, `Parcel.open(parcel) => Promise<Passable>`, `Parcel.locate(parcel) => location:string`.
> The `%SharedParcel%` would not provide `locate`, but would otherwise be the same.
> Lockdown would harden `%InitialParcel%` and `%SharedParcel%`, such that endowing `%InitialParcel%` would be safe, but confer the authority to see the cryptographic information in a parcel location.
> Parcels would be passable over CapTP, particularly OCapN, where they are passed as data and reified as opaque Parcel instances.
> The pass-style of a Parcel would be literally "parcel".
> The semantics of Parcel passing are that parcels do not have pass-invariant equality (like Promise) and opening a Parcel twice does not guarantee that the promises converge on the same referent.
> A Parcel may survive partition with the originating peer, but can't be used to match a grant.
> The purpose of a Parcel is to support distributed confinement and durable capabilities.
> It must be a first-shim-wins race, similar to the patterns for lockdown and harden, and HandledPromise.
> (kriskowal, liaison session 2026-10-14; sketch at https://gist.github.com/kriskowal/b266d5ab8ba047ccea9097b39f271114.)
> "Let's start with a reviewable design taken from the proposed essay."
