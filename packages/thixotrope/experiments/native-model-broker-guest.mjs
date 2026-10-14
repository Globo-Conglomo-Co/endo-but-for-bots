// Control and model facets have separate identities. The agent is granted only
// model.complete; the operator rebinds control after a supervisor restart.
/** @type {{ Far: typeof import('@endo/far').Far, E: typeof import('@endo/far').E }} */
const { Far, E } = /** @type {{ Far: typeof import('@endo/far').Far, E: typeof import('@endo/far').E }} */ (/** @type {unknown} */ (globalThis));

export const make = () => {
  let host;
  const model = Far('ExplicitModelGrant', {
    complete: request => {
      if (!host) throw Error('Model broker is not bound');
      return E(host).complete(request);
    },
  });
  return Far('ModelBrokerControl', {
    model: () => model,
    bind: next => {
      host = next;
      return true;
    },
  });
};
