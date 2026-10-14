// The tool is a separate persistent vat. A per-step key makes retries safe.
/** @type {{ Far: typeof import('@endo/far').Far }} */
const { Far } = /** @type {{ Far: typeof import('@endo/far').Far }} */ (/** @type {unknown} */ (globalThis));

export const make = () => {
  let sum = 0;
  const outcomes = new Map();
  return Far('ExplicitAddTool', {
    call: (name, args, key) => {
      if (name !== 'add' || !Array.isArray(args) || args.length !== 1 ||
          !Number.isSafeInteger(args[0]) || Math.abs(args[0]) > 1000 ||
          typeof key !== 'string' || key.length > 120) throw Error('Invalid tool call');
      if (outcomes.has(key)) return outcomes.get(key);
      sum += args[0];
      outcomes.set(key, sum);
      return sum;
    },
    read: () => sum,
  });
};
