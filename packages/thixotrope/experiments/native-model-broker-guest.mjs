// Control and model facets have separate identities. The agent is granted only
// model.complete; the operator rebinds control after a supervisor restart.
// The confined guest environment injects these two explicit language facets.
const { Far, E } = /** @type {{ Far: (name: string, methods: object) => any, E: (ref: any) => any }} */ (/** @type {unknown} */ (globalThis));

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
