// Runs the URI globals through a real, privately started Ironhorse supervisor.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import process from 'node:process';

const child = spawn(process.execPath, [new URL('./eval-driver.mjs', import.meta.url).pathname], {
  stdio: ['pipe', 'pipe', 'inherit'],
});
const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
const replies = lines[Symbol.asyncIterator]();
let id = 0;
const request = async (op, args = {}) => {
  id += 1;
  child.stdin.write(`${JSON.stringify({ id, op, ...args })}\n`);
  const { value: line, done } = await replies.next();
  if (done) throw Error(`Driver exited during ${op}`);
  const response = JSON.parse(line);
  assert.equal(response.id, id);
  if (!response.ok) throw Error(`${op}: ${response.error.message}`);
  return response.value;
};

try {
  await request('start');
  await request('install', {
    name: 'uri-check',
    source: `const make = () => Far('URI check', {
      check: () => {
        const malformed = expression => {
          try { expression(); return 'miss'; }
          catch (error) { return error instanceof URIError && error.name === 'URIError'; }
        };
        return {
          types: [typeof encodeURI, typeof decodeURI, typeof encodeURIComponent, typeof decodeURIComponent],
          utf8: encodeURIComponent('é😀漢'),
          decoded: decodeURIComponent('%C3%A9%F0%9F%98%80%E6%BC%A2'),
          reserved: decodeURI('%2f%3F%23%20'),
          component: encodeURIComponent('a b/?#&'),
          malformed: [
            malformed(() => encodeURI('\\uD800')),
            malformed(() => decodeURIComponent('%C0%80')),
            malformed(() => decodeURIComponent('%ED%A0%80')),
            malformed(() => decodeURIComponent('%E2%82')),
          ],
        };
      },
    });`,
  });
  const result = await request('invoke', { name: 'uri-check', method: 'check' });
  assert.deepEqual(result.types, ['function', 'function', 'function', 'function']);
  assert.equal(result.utf8, '%C3%A9%F0%9F%98%80%E6%BC%A2');
  assert.equal(result.decoded, 'é😀漢');
  assert.equal(result.reserved, '%2f%3F%23 ');
  assert.equal(result.component, 'a%20b%2F%3F%23%26');
  assert.deepEqual(result.malformed, [true, true, true, true]);
  await request('restart');
  assert.deepEqual(await request('invoke', { name: 'uri-check', method: 'check' }), result);
  await request('close');
  console.log('native URI intrinsics supervisor smoke passed');
} finally {
  child.stdin.end();
  child.kill('SIGTERM');
}
