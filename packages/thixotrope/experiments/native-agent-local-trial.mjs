// Opt-in local-model trial. Run only when the local model owner reserves the GPU.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import process from 'node:process';

const baseUrl = process.env.NATIVE_MODEL_URL;
const model = process.env.NATIVE_MODEL_ID;
const repeats = Number(process.env.NATIVE_REPEATS || 4);
if (!baseUrl || !model || !Number.isInteger(repeats) || repeats < 1 || repeats > 4)
  throw Error('Set NATIVE_MODEL_URL and NATIVE_MODEL_ID; NATIVE_REPEATS must be 1–4');

const child = spawn(process.execPath, [new URL('./native-agent-driver.mjs', import.meta.url).pathname], {
  stdio: ['pipe', 'pipe', 'inherit'],
});
const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
const pending = new Map();
lines.on('line', line => {
  const response = JSON.parse(line);
  const waiting = pending.get(response.id);
  if (!waiting) throw Error(`Unexpected driver response ${response.id}`);
  pending.delete(response.id);
  if (response.ok) waiting.resolve(response.value);
  else waiting.reject(Error(response.error.message));
});
child.once('exit', (code, signal) => {
  for (const waiting of pending.values()) waiting.reject(Error(`Native driver exited (${code ?? signal})`));
  pending.clear();
});
let serial = 0;
const ask = (op, args = {}) => new Promise((resolve, reject) => {
  serial += 1;
  const id = serial;
  pending.set(id, { resolve, reject });
  child.stdin.write(`${JSON.stringify({ id, op, ...args })}\n`);
});
const cases = [
  { name: 'composition', increment: 4, prompt: 'Call add with 4. Store the returned total as a decimal string under key "composition-result" using remember. Call recall with that key. Answer with the recalled value.' },
  { name: 'invalid-recovery', increment: 2, prompt: 'Call the add tool with 2, then give the resulting total.' },
  { name: 'durable-continue', increment: 7, prompt: 'Call the add tool with 7, then give the resulting total.' },
];
const results = [];
const schedule = Array.from({ length: repeats }, (_, round) =>
  cases.map((_case, index) => ({ round, entry: cases[(index + round) % cases.length] }))).flat();
const runCell = async index => {
  if (index >= schedule.length) return;
  const { round, entry } = schedule[index];
  const turnId = `local-${round}-${entry.name}`;
  await ask('bindModel', { model: { kind: 'local-http', baseUrl, model,
    injectInvalidOnce: entry.name === 'invalid-recovery' } });
  const before = await ask('toolRead');
  let paused;
  let restarted;
  let outcome;
  if (entry.name === 'durable-continue') {
    paused = await ask('run', { turnId, prompt: entry.prompt, maxSteps: 1 });
    restarted = await ask('restart');
    outcome = await ask('run', { turnId, prompt: entry.prompt, maxSteps: 4 });
  } else {
    outcome = await ask('run', { turnId, prompt: entry.prompt, maxSteps: 4 });
  }
  const after = await ask('toolRead');
  const history = outcome.turn.history || [];
  const actions = history.filter(item => item.action).map(item => item.action);
  const invalidFeedback = history.filter(item => item.invalidAction).length;
  const expectedActions = entry.name === 'composition'
    ? [{ name: 'add', args: [4] },
      { name: 'remember', args: ['composition-result', String(after)] },
      { name: 'recall', args: ['composition-result'] }]
    : [{ name: 'add', args: [entry.increment] }];
  const exactActions = JSON.stringify(actions.map(({ name, args }) => ({ name, args }))) ===
    JSON.stringify(expectedActions);
  const note = entry.name === 'composition' ? await ask('noteRead', { key: 'composition-result' }) : undefined;
  const recalled = history.find(item => item.action?.name === 'recall')?.value;
  const passed = outcome.turn.phase === 'done' && after - before === entry.increment &&
    exactActions &&
    (entry.name === 'composition' ? note?.value === String(after) &&
      recalled?.value === String(after) && outcome.turn.answer.includes(String(after)) : true) &&
    (entry.name === 'invalid-recovery' ? invalidFeedback >= 1 : true) &&
    (entry.name === 'durable-continue' ? paused?.turn.phase === 'paused' : true);
  const record = { round, case: entry.name, passed, phase: outcome.turn.phase,
    actions, invalidFeedback, toolDelta: after - before,
    operationMs: outcome.operationMs, pausedPhase: paused?.turn.phase,
    restartMs: restarted?.restartMs };
  results.push(record);
  console.log(JSON.stringify({ result: record }));
  await runCell(index + 1);
};
try {
  const started = await ask('start');
  const provisioned = await ask('provision');
  await runCell(0);
  assert.equal(results.length, 3 * repeats);
  console.log(JSON.stringify({ summary: {
    sourceRevision: '5a40d85326cf94cecf3f34acb703a8681fdbc14a',
    model, baseUrl, repeats, cells: results.length,
    passed: results.filter(result => result.passed).length,
    coldStartupMs: started.startupMs, provisionMs: provisioned.provisionMs,
  } }));
  await ask('close');
} finally {
  child.stdin.end();
  child.kill('SIGTERM');
}
