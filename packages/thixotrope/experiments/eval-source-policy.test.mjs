import assert from 'node:assert/strict';
import test from 'node:test';

import { installGuestSource, prepareInstallSource } from './eval-source-policy.mjs';

const host = events => ({
  name: 'candidate',
  grants: [],
  sourceUrl: import.meta.url,
  writeFile: async (_path, source, options) => {
    events.push('write');
    assert.equal(options.mode, 0o600);
    assert.match(source, /export\s*\{\s*make\s*\}/);
  },
  bundle: async () => {
    events.push('bundle');
    return { bundle: 'guest-bundle' };
  },
  install: async (_name, bundle) => {
    events.push('install');
    assert.equal(bundle, 'guest-bundle');
    return true;
  },
  removeFile: async () => { events.push('remove'); },
});

test('normal factory sources and harmless import text reach the bundler', async () => {
  const events = [];
  const source = `// import secret from './eval-host-secret.mjs';
    const make = () => Far('Candidate', {
      text: () => "import('./eval-host-secret.mjs')",
      import: () => true,
    });`;
  assert.equal(await installGuestSource({ ...host(events), source }), true);
  assert.deepEqual(events, ['write', 'bundle', 'install', 'remove']);
  assert.match(prepareInstallSource('() => true'), /^export const make = /);
  assert.equal(
    prepareInstallSource('export function make() { return true; }'),
    'export function make() { return true; }',
  );
});

test('host modules cannot enter through any guest import form', async () => {
  const refused = [
    `import secret from './eval-host-secret.mjs'; export const make = () => secret;`,
    `export { secret as make } from './eval-host-secret.mjs';`,
    `export const make = () => import('./eval-host-secret.mjs');`,
    `export const make = () => import('./eval-host-secret.json', { with: { type: 'json' } });`,
    `export const make = () => import.meta.url;`,
  ];
  for (const source of refused) {
    const events = [];
    // The fake host records every path that could write or read host files.
    // Rejection must happen before any of those paths run.
    // eslint-disable-next-line no-await-in-loop
    await assert.rejects(installGuestSource({ ...host(events), source }));
    assert.deepEqual(events, [], source);
  }
});

test('guest source can export only its make factory', async () => {
  const events = [];
  await assert.rejects(
    installGuestSource({
      ...host(events),
      source: `export const make = () => true; export const leak = 1;`,
    }),
    /export only make/,
  );
  assert.deepEqual(events, []);
});
