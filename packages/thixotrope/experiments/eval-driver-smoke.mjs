import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import process from 'node:process';

const child = spawn(process.execPath, [new URL('./eval-driver.mjs', import.meta.url).pathname], {
  stdio: ['pipe', 'pipe', 'inherit'],
});
const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
const iterator = lines[Symbol.asyncIterator]();
let id = 0;
const request = async (op, args = {}) => {
  id += 1;
  child.stdin.write(`${JSON.stringify({ id, op, ...args })}\n`);
  const { value: line, done } = await iterator.next();
  if (done) throw Error(`Driver exited during ${op}`);
  const response = JSON.parse(line);
  assert.equal(response.id, id);
  if (!response.ok) throw Error(`${op}: ${response.error.message}`);
  return response.value;
};

try {
  const started = await request('start');
  assert.match(started.statePath, /^\/tmp\/thix-eval-/);
  await request('install', {
    name: 'fixture',
    source: `const make = () => Far('Fixture', {
      nested: () => Far('Nested', { twice: value => value * 2 }),
    });`,
  });
  await request('install', {
    name: 'candidate-store',
    store: true,
  });
  await request('install', {
    name: 'candidate',
    source: `const make = ({ fixture, store }) => {
      let count = 0;
      return Far('Candidate', {
        next: async () => {
          count += 1;
          const doubled = await E(E(fixture).nested()).twice(count);
          await E(store).set('last', doubled);
          return doubled;
        },
        read: () => count,
        ambient: () => [typeof process, typeof require],
      });
    };`,
    grants: { fixture: 'fixture', store: 'candidate-store' },
  });
  assert.equal(await request('invoke', { name: 'candidate', method: 'next' }), 2);
  assert.equal(await request('invoke', { name: 'candidate-store', method: 'get', args: ['last'] }), 2);
  assert.deepEqual(await request('invoke', { name: 'candidate', method: 'ambient' }), ['undefined', 'undefined']);
  await request('restart');
  assert.equal(await request('invoke', { name: 'candidate', method: 'read' }), 1);
  assert.equal(await request('invoke', { name: 'candidate', method: 'next' }), 4);
  assert.equal(await request('invoke', { name: 'candidate-store', method: 'get', args: ['last'] }), 4);
  await request('close');
  console.log('real Ironhorse supervisor adapter smoke passed');
} finally {
  child.stdin.end();
  child.kill('SIGTERM');
}
