// Two independent supervisor processes, each with its own Ironhorse workers.
// Mail carries a live capability over the private thix-unix peer socket.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { performance } from 'node:perf_hooks';
import { setTimeout } from 'node:timers';
import process from 'node:process';

const exec = promisify(execFile);
const cli = new URL('../bin/thix.js', import.meta.url).pathname;
const command = async (verb, state, ...args) => {
  const { stdout } = await exec(process.execPath, [cli, verb, state, ...args], { maxBuffer: 1024 * 1024 });
  return verb === 'invite' ? stdout.trim() : JSON.parse(stdout);
};
const makeDriver = () => {
  const child = spawn(process.execPath, [new URL('./eval-driver.mjs', import.meta.url).pathname], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  let serial = 0;
  return {
    ask: async (op, args = {}) => {
      serial += 1;
      const id = serial;
      child.stdin.write(`${JSON.stringify({ id, op, ...args })}\n`);
      const { value: line, done } = await iterator.next();
      if (done) throw Error(`Peer driver exited during ${op}`);
      const response = JSON.parse(line);
      assert.equal(response.id, id);
      if (!response.ok) throw Error(`${op}: ${response.error.message}`);
      return response.value;
    },
    end: () => { child.stdin.end(); child.kill('SIGTERM'); },
  };
};
const alice = makeDriver();
const bob = makeDriver();
const aSource = `const make = () => {
  let calls = 0;
  const nested = Far('NestedPeer', { twice: n => n * 2 });
  return Far('AlicePeer', {
    nested: () => nested,
    callBack: async cb => E(cb).echo('from-alice'),
    delayed: async () => 'settled-from-alice',
    fail: () => { throw Error('peer-error-sentinel'); },
    count: () => ++calls,
  });
};`;
const bSource = `const make = ({ peer }) => Far('BobProbe', {
  probe: async () => {
    const first = await E(peer).nested();
    const second = await E(peer).nested();
    const callback = Far('BobCallback', { echo: text => 'callback:' + text });
    let error = '';
    try { await E(peer).fail(); } catch (e) { error = String(e.message); }
    return {
      nested: await E(first).twice(5),
      sameReference: first === second,
      callback: await E(peer).callBack(callback),
      promise: await E(peer).delayed(),
      error,
      count: await E(peer).count(),
    };
  },
});`;
const waitFor = check => {
  const poll = async n => {
    if (n >= 40) throw Error('Peer exchange did not become ready');
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 250));
    return poll(n + 1);
  };
  return poll(0);
};
try {
  const before = performance.now();
  const a = await alice.ask('start');
  const b = await bob.ask('start');
  const startupMs = Math.round(performance.now() - before);
  const provisionAt = performance.now();
  await alice.ask('install', { name: 'alice-cap', source: aSource });
  const invitation = await command('invite', a.statePath, 'bob');
  await command('accept', b.statePath, 'alice', invitation);
  await waitFor(async () => (await command('contacts', a.statePath)).some(c => c.name === 'bob' && c.status === 'ready'));
  await waitFor(async () => (await command('contacts', b.statePath)).some(c => c.name === 'alice' && c.status === 'ready'));
  await command('send', a.statePath, 'bob', 'live peer capability', 'alice-cap');
  const inbox = await waitFor(async () => (await command('inbox', b.statePath)).find(m => m.text === 'live peer capability'));
  await command('take', b.statePath, inbox.id, 'remote-alice');
  await bob.ask('install', { name: 'bob-probe', source: bSource, grants: { peer: 'remote-alice' } });
  const provisionMs = Math.round(performance.now() - provisionAt);
  const firstAt = performance.now();
  const first = await bob.ask('invoke', { name: 'bob-probe', method: 'probe' });
  const firstOperationMs = Math.round(performance.now() - firstAt);
  assert.deepEqual(first, { nested: 10, sameReference: true, callback: 'callback:from-alice', promise: 'settled-from-alice', error: 'peer-error-sentinel', count: 1 });
  const warmAt = performance.now();
  const warm = await bob.ask('invoke', { name: 'bob-probe', method: 'probe' });
  const warmOperationMs = Math.round(performance.now() - warmAt);
  assert.equal(warm.count, 2);
  const restartAt = performance.now();
  await alice.ask('restart');
  const restartMs = Math.round(performance.now() - restartAt);
  const after = await bob.ask('invoke', { name: 'bob-probe', method: 'probe' });
  assert.equal(after.count, 3, 'retained remote capability resumes with its state');
  assert.equal(after.sameReference, true);
  await alice.ask('close');
  await bob.ask('close');
  console.log(JSON.stringify({ result: 'two-supervisor-thix-unix-peer-pass', sourceRevision: '5a40d85326cf94cecf3f34acb703a8681fdbc14a', startupMs, provisionMs, firstOperationMs, warmOperationMs, restartMs }));
} finally {
  alice.end();
  bob.end();
}
