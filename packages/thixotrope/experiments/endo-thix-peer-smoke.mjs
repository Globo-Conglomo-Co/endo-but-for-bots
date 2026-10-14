#!/usr/bin/env node
// Two independent processes: PR-pinned Thix supervisor and current-main Endo OCapN peer.
import '@endo/init';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import process from 'node:process';

import { connectLocalControl } from '../src/control/local-control.js';
import { makeNodePowers } from '../src/platform/node/powers.js';

const thixRoot = fileURLToPath(new URL('../../../', import.meta.url));
const endoRoot = process.env.ENDO_PEER_ROOT;
if (!endoRoot) throw Error('Set ENDO_PEER_ROOT to the isolated current-main Endo checkout');
const endoScript = join(endoRoot, 'packages/ocapn/test/_endo-thix-peer.mjs');
const revision = root => execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const makeDriver = script => {
  const child = spawn(process.execPath, [script], { stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  let serial = 0;
  return {
    ask: async (op, args = {}) => {
      serial += 1;
      const id = serial;
      child.stdin.write(`${JSON.stringify({ id, op, ...args })}\n`);
      const { value: line, done } = await iterator.next();
      if (done) throw Error(`${script} exited during ${op}`);
      const response = JSON.parse(line);
      assert.equal(response.id, id);
      if (!response.ok) throw Error(`${op}: ${response.error.message}`);
      return response.value;
    },
    end: () => { child.stdin.end(); child.kill('SIGTERM'); },
  };
};
const thix = makeDriver(new URL('./eval-driver.mjs', import.meta.url).pathname);
const endo = makeDriver(endoScript);
const source = `const make = () => {
  let calls = 0;
  let retained;
  const nested = Far('ReturnedThixFacet', { twice: number => number * 2 });
  return Far('NamedThixPeerCap', {
    nested: () => nested,
    callBack: callback => E(callback).echo('direct'),
    retain: callback => { retained = callback; return true; },
    callRetained: () => E(retained).echo('held'),
    delayed: async () => 'settled-from-thix',
    fail: () => { throw Error('thix-peer-error-sentinel'); },
    count: () => { calls += 1; return calls; },
  });
};`;
const check = (value, expectedCount, callbackOffset) => {
  assert.deepEqual(value, {
    nested: 10,
    sameReference: true,
    callback: `endo:direct:${callbackOffset + 1}`,
    retainedCallback: `endo:held:${callbackOffset + 2}`,
    promise: 'settled-from-thix',
    error: 'thix-peer-error-sentinel',
    count: expectedCount,
    callbackCalls: callbackOffset + 2,
  });
};
try {
  const startupAt = performance.now();
  const { statePath } = await thix.ask('start');
  const startupMs = Math.round(performance.now() - startupAt);
  const provisionAt = performance.now();
  await thix.ask('install', { name: 'thix-peer-cap', source });
  const control = await connectLocalControl(makeNodePowers(), join(statePath, 'control.sock'));
  let registryWorkerId;
  try { ({ registry: registryWorkerId } = await control.call('status')); }
  finally { control.close(); }
  await endo.ask('start', { thixStatePath: statePath, registryWorkerId, thixSourceRoot: thixRoot });
  const provisionMs = Math.round(performance.now() - provisionAt);
  const firstAt = performance.now();
  const first = await endo.ask('probe');
  const firstOperationMs = Math.round(performance.now() - firstAt);
  check(first, 1, 0);
  const warmAt = performance.now();
  const warm = await endo.ask('probe');
  const warmOperationMs = Math.round(performance.now() - warmAt);
  check(warm, 2, 2);
  const restartAt = performance.now();
  await thix.ask('restart');
  const restartMs = Math.round(performance.now() - restartAt);
  const after = await endo.ask('probe');
  check(after, 3, 4);
  await endo.ask('close');
  await thix.ask('close');
  console.log(JSON.stringify({ result: 'current-endo-thix-direct-peer-pass',
    thixRevision: revision(thixRoot), endoRevision: revision(endoRoot),
    startupMs, provisionMs, firstOperationMs, warmOperationMs, restartMs }));
} finally {
  endo.end();
  thix.end();
}
