// A separate persistent resource vat. Only the named agent grant can call it.
const { Far } = /** @type {{ Far: (name: string, methods: object) => any }} */ (/** @type {unknown} */ (globalThis));

export const make = () => {
  const entries = new Map();
  const writes = new Map();
  return Far('ExplicitNotesTool', {
    call: (name, args, idempotencyKey) => {
      if (typeof idempotencyKey !== 'string' || idempotencyKey.length > 120)
        throw Error('Invalid note call key');
      if (name === 'recall' && Array.isArray(args) && args.length === 1 &&
          typeof args[0] === 'string' && args[0].length > 0 && args[0].length <= 80)
        return entries.get(args[0]);
      if (name !== 'remember' || !Array.isArray(args) || args.length !== 2 ||
          typeof args[0] !== 'string' || !args[0] || args[0].length > 80 ||
          typeof args[1] !== 'string' || args[1].length > 500)
        throw Error('Invalid note action');
      if (writes.has(idempotencyKey)) return writes.get(idempotencyKey);
      const value = harden({ key: args[0], value: args[1] });
      entries.set(args[0], value);
      writes.set(idempotencyKey, value);
      return value;
    },
    read: key => entries.get(key),
  });
};
