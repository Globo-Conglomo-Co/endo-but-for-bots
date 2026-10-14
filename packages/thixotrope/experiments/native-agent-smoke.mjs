// Real Ironhorse, scripted model facet. No model service or host state touched.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { setTimeout } from 'node:timers';

const child = spawn(process.execPath, [new URL('./native-agent-driver.mjs', import.meta.url).pathname], {
  stdio: ['pipe', 'pipe', 'inherit'],
});
let stub;
const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
const pending = new Map();
lines.on('line', line => {
  const response = JSON.parse(line);
  const waiting = pending.get(response.id);
  if (!waiting) throw Error(`Unexpected response ${response.id}`);
  pending.delete(response.id);
  if (response.ok) waiting.resolve(response.value);
  else waiting.reject(Error(response.error.message));
});
child.once('exit', (code, signal) => {
  for (const waiting of pending.values()) waiting.reject(Error(`Native driver exited (${code ?? signal})`));
  pending.clear();
});
let serial = 0;
const ask = (op, args = {}) => {
  serial += 1;
  const id = serial;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ id, op, ...args })}\n`);
  });
};
const responses = [
  { kind: 'tool', name: 'add', args: [3] },
  { kind: 'answer', text: 'The total is 3.' },
  { kind: 'tool', name: 'add', args: [4] },
  { kind: 'answer', text: 'The total is 7.' },
  { kind: 'answer', text: 'After restart, the total is still 7.' },
  { kind: 'tool', name: 'forbidden', args: [100] },
  { kind: 'answer', text: 'I will use only the granted tool.' },
  { kind: 'answer', text: 'must be cancelled', delayMs: 5000 },
  { kind: 'tool', name: 'add', args: [6] },
  { kind: 'answer', text: 'The resumed total is 13.' },
  { kind: 'tool', name: 'add', args: [2] },
  { kind: 'tool', name: 'remember', args: ['mixed-result', '15'] },
  { kind: 'tool', name: 'recall', args: ['mixed-result'] },
  { kind: 'answer', text: 'The stored result is 15.' },
];
try {
  const processStart = performance.now();
  const started = await ask('start');
  const processToStartedMs = Math.round(performance.now() - processStart);
  const provisioned = await ask('provision');
  await ask('bindModel', { model: { kind: 'scripted', responses } });
  const first = await ask('run', { turnId: 'first', prompt: 'Add three, then answer.' });
  assert.equal(first.turn.phase, 'done');
  assert.equal(first.turn.history.length, 1);
  assert.equal(first.turn.history[0].value, 3);
  const warm = await ask('run', { turnId: 'warm', prompt: 'Add four, then answer.' });
  assert.equal(warm.turn.phase, 'done');
  assert.equal(warm.turn.history[0].value, 7);
  assert.equal(await ask('toolRead'), 7);
  const restarted = await ask('restart');
  assert.equal(restarted.rebound, true);
  assert.equal((await ask('status', { turnId: 'first' })).answer, 'The total is 3.');
  assert.equal((await ask('status', { turnId: 'warm' })).history[0].value, 7);
  assert.equal(await ask('toolRead'), 7);
  const after = await ask('run', { turnId: 'after', prompt: 'Report the total.' });
  assert.equal(after.turn.phase, 'done');
  const invalid = await ask('run', { turnId: 'invalid', prompt: 'Try an invalid action.' });
  assert.equal(invalid.turn.phase, 'done');
  assert.equal(invalid.turn.history[0].invalidAction.length > 0, true);
  assert.equal(await ask('toolRead'), 7, 'invalid model action cannot invoke a tool');
  const interrupted = ask('run', { turnId: 'cancelled', prompt: 'Wait for a slow model.' });
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(await ask('cancel', { turnId: 'cancelled' }), true);
  assert.equal((await interrupted).turn.phase, 'cancelled');
  assert.equal(await ask('toolRead'), 7);
  const paused = await ask('run', { turnId: 'paused', prompt: 'Add six, then answer.', maxSteps: 1 });
  assert.equal(paused.turn.phase, 'paused');
  assert.equal(await ask('toolRead'), 13);
  await ask('restart');
  const resumed = await ask('run', { turnId: 'paused', prompt: 'Add six, then answer.', maxSteps: 4 });
  assert.equal(resumed.turn.phase, 'done');
  assert.equal(resumed.turn.history.length, 1, 'the tool did not repeat after restart');
  assert.equal(await ask('toolRead'), 13);
  const mixed = await ask('run', { turnId: 'mixed',
    prompt: 'Add two, remember the total, recall the note, then answer.', maxSteps: 4 });
  assert.equal(mixed.turn.phase, 'done');
  assert.deepEqual(mixed.turn.history.map(item => item.action?.name), ['add', 'remember', 'recall']);
  assert.deepEqual(mixed.turn.history[1].value, { key: 'mixed-result', value: '15' });
  assert.deepEqual(mixed.turn.history[2].value, { key: 'mixed-result', value: '15' });
  assert.equal(await ask('toolRead'), 15);
  assert.deepEqual(await ask('noteRead', { key: 'mixed-result' }), { key: 'mixed-result', value: '15' });
  await ask('restart');
  assert.deepEqual(await ask('noteRead', { key: 'mixed-result' }), { key: 'mixed-result', value: '15' });
  assert.equal((await ask('status', { turnId: 'mixed' })).phase, 'done');
  const modelRequests = [];
  stub = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    modelRequests.push({ path: request.url, headers: request.headers, body: JSON.parse(raw) });
    const action = modelRequests.length === 1
      ? { kind: 'tool', name: 'add', args: [1] }
      : { kind: 'answer', text: 'The new total is 16.' };
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(action) } }] }));
  });
  await new Promise(resolve => stub.listen(0, '127.0.0.1', resolve));
  const address = stub.address();
  if (!address || typeof address === 'string') throw Error('Expected localhost test server port');
  await ask('bindModel', { model: { kind: 'local-http',
    baseUrl: `http://127.0.0.1:${address.port}`, model: 'stub' } });
  const local = await ask('run', { turnId: 'local-stub', prompt: 'Add one, then answer.' });
  assert.equal(local.turn.phase, 'done');
  assert.equal(local.turn.history[0].value, 16);
  assert.equal(modelRequests.length, 2);
  assert.equal(modelRequests[0].path, '/v1/chat/completions');
  assert.equal(modelRequests[0].body.max_tokens, 4096);
  assert.deepEqual(modelRequests[0].body.chat_template_kwargs, { enable_thinking: false });
  assert.equal(modelRequests[0].headers.authorization, undefined);
  const closed = await ask('close');
  assert.equal(closed, true);
  console.log(JSON.stringify({
    result: 'native-agent-scripted-smoke-pass',
    sourceRevision: '5a40d85326cf94cecf3f34acb703a8681fdbc14a',
    processToStartedMs,
    coldStartupMs: started.startupMs,
    provisionMs: provisioned.provisionMs,
    firstOperationMs: first.operationMs,
    warmOperationMs: warm.operationMs,
    restartMs: restarted.restartMs,
    afterRestartOperationMs: after.operationMs,
  }));
} finally {
  stub?.close();
  child.stdin.end();
  child.kill('SIGTERM');
}
