// This module is installed as source in its own Ironhorse vat. Its only
// authority is the two named facets the installer grants.
// These names are injected by the confined guest environment. This source is
// bundled for SES, so its type comments must contain no import syntax.
const { Far, E } = /** @type {{ Far: (name: string, methods: object) => any, E: (ref: any) => any }} */ (/** @type {unknown} */ (globalThis));

export const make = ({ model, tool, notes }) => {
  const turns = new Map();
  const copy = row => harden({ ...row, history: [...row.history] });
  const validAction = action => {
    if (action?.kind !== 'tool' || !Array.isArray(action.args)) return false;
    if (action.name === 'add') return action.args.length === 1 &&
      Number.isSafeInteger(action.args[0]) && Math.abs(action.args[0]) <= 1000;
    if (action.name === 'remember') return action.args.length === 2 &&
      typeof action.args[0] === 'string' && action.args[0].length > 0 && action.args[0].length <= 80 &&
      typeof action.args[1] === 'string' && action.args[1].length <= 500;
    if (action.name === 'recall') return action.args.length === 1 &&
      typeof action.args[0] === 'string' && action.args[0].length > 0 && action.args[0].length <= 80;
    return false;
  };
  /** @returns {Promise<any>} */
  const advance = async (row, id, prompt, maxSteps) => {
    if (row.cancelled) {
      row.phase = 'cancelled';
      return copy(row);
    }
    if (row.steps >= maxSteps) {
      row.phase = 'paused';
      return copy(row);
    }
    if (row.phase === 'tool') {
      // The action is durable before the effect. A repeated call uses the
      // same idempotency key in the separate tool vat.
      const action = row.action;
      let value;
      try {
        const target = action.name === 'add' ? tool : notes;
        value = await E(target).call(action.name, action.args, `${id}:${row.steps}`);
      }
      catch (error) {
        row.phase = row.cancelled ? 'cancelled' : 'error';
        row.error = (error instanceof Error ? error.message : String(error)).slice(0, 300);
        return copy(row);
      }
      row.history.push(harden({ action, value }));
      row.action = undefined;
      row.phase = 'model';
      row.steps += 1;
      return advance(row, id, prompt, maxSteps);
    }
    row.phase = 'waiting-model';
    let action;
    try { action = await E(model).complete(harden({ prompt, history: [...row.history] })); }
    catch (error) {
      row.phase = row.cancelled ? 'cancelled' : 'error';
      row.error = (error instanceof Error ? error.message : String(error)).slice(0, 300);
      return copy(row);
    }
    if (row.cancelled) {
      row.phase = 'cancelled';
      return copy(row);
    }
    if (action?.kind === 'answer' && typeof action.text === 'string') {
      row.answer = action.text.slice(0, 4000);
      row.phase = 'done';
      return copy(row);
    }
    if (!validAction(action)) {
      row.history.push(harden({ invalidAction: 'Granted actions: add(integer), remember(key,string), recall(key), or answer.' }));
      row.steps += 1;
      row.phase = 'model';
      return advance(row, id, prompt, maxSteps);
    }
    row.action = harden({ name: action.name, args: [...action.args] });
    row.phase = 'tool';
    return advance(row, id, prompt, maxSteps);
  };
  return Far('NativeEvalAgent', {
    status: id => {
      const row = turns.get(id);
      return row ? copy(row) : undefined;
    },
    cancel: id => {
      const row = turns.get(id);
      if (!row || row.phase === 'done') return false;
      row.cancelled = true;
      return true;
    },
    run: async (id, prompt, maxSteps = 4) => {
      if (typeof id !== 'string' || !id || id.length > 100 ||
          typeof prompt !== 'string' || !prompt || prompt.length > 4000 ||
          !Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 8) {
        throw Error('Invalid bounded turn');
      }
      let row = turns.get(id);
      if (!row) {
        row = { id, prompt, phase: 'model', history: [], cancelled: false, steps: 0 };
        turns.set(id, row);
      }
      if (row.prompt !== prompt) throw Error('Turn id already names a different prompt');
      if (['done', 'cancelled', 'error'].includes(row.phase)) return copy(row);
      return advance(row, id, prompt, maxSteps);
    },
  });
};
