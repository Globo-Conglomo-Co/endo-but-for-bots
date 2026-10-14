#!/usr/bin/env node
// Experimental JSON-lines driver for an isolated, real Ironhorse supervisor.
// Each request is {id, op, ...}; each response is {id, ok, value? , error?}.
import '@endo/init';
import { E } from '@endo/far';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { connectLocalControl } from '../src/control/local-control.js';
import { serveThixotrope } from '../src/control/supervisor.js';
import { makeNodePowers } from '../src/platform/node/powers.js';
import { makeLogPowers } from '../src/platform/logging.js';

// Native resources and the supervisor may log. Keep stdout a pure RPC stream.
const platform = {
  ...makeNodePowers(),
  logging: makeLogPowers({
    log: (...args) => console.error(...args),
    info: (...args) => {
      if (process.env.THIXOTROPE_TRACE) console.error(...args);
    },
    error: (...args) => console.error(...args),
  }),
};
const storeSource = `const make = () => {
  const values = new Map();
  return Far('Store', {
    get: key => values.get(key),
    has: key => values.has(key),
    set: (key, value) => { values.set(key, value); return true; },
    delete: key => values.delete(key),
  });
};`;
let supervisor;
let client;
let statePath;
let ownedState = false;

const reply = (id, payload) =>
  process.stdout.write(`${JSON.stringify({ id, ...payload }, (_key, value) =>
    typeof value === 'bigint' ? { bigint: String(value) } : value,
  )}\n`);

const stop = async () => {
  client?.close();
  client = undefined;
  if (supervisor) {
    await supervisor.close();
    supervisor = undefined;
  }
};

const start = async (path, owns = false) => {
  statePath = path;
  ownedState = owns;
  supervisor = await serveThixotrope(platform, path);
  client = await connectLocalControl(
    platform,
    join(path, 'control.sock'),
  );
  return { statePath: path };
};

const needClient = () => {
  if (!client) throw Error('Driver is not started');
  return client;
};

const installSource = async (name, source, grants) => {
  // Compartment Mapper needs an enclosing package.json for the entry URL.
  const sourcePath = fileURLToPath(new URL(`./eval-${randomUUID()}.mjs`, import.meta.url));
  const moduleSource = /\bexport\s+(?:const|function)\s+make\b/.test(source)
    ? source
    : /\b(?:const|function)\s+make\b/.test(source)
      ? `${source}\nexport { make };\n`
      : `export const make = (${source});\n`;
  try {
    await writeFile(sourcePath, moduleSource, { mode: 0o600 });
    const { bundle } = await platform.bundler.bundle(sourcePath);
    return await needClient().call('install', name, bundle, grants);
  } finally {
    await rm(sourcePath, { force: true });
  }
};

const operations = {
  async start({ statePath: requestedPath }) {
    if (client) throw Error('Driver is already started');
    const owns = requestedPath === undefined;
    const path = owns
      ? await mkdtemp(join(tmpdir(), 'thix-eval-'))
      : resolve(requestedPath);
    if (!owns) await mkdir(path, { recursive: true, mode: 0o700 });
    return start(path, owns);
  },
  async evaluate({ source }) {
    if (typeof source !== 'string') throw Error('Expected source string');
    return needClient().call('evaluate', source);
  },
  async install({ name, source, grants = [], store = false }) {
    if (typeof name !== 'string' || (!store && typeof source !== 'string'))
      throw Error('Expected installation name and source');
    if (!Array.isArray(grants) && (grants === null || typeof grants !== 'object'))
      throw Error('Expected grants array or object');
    const pairs = Array.isArray(grants) ? grants : Object.entries(grants);
    if (store && source !== undefined)
      throw Error('Store fixture installation takes no source');
    await installSource(name, store ? storeSource : source, pairs);
    return { installed: name };
  },
  async invoke({ name, method, args = [] }) {
    if (typeof name !== 'string' || typeof method !== 'string' || !Array.isArray(args))
      throw Error('Expected name, method, and args array');
    const current = needClient();
    const service = await current.call('lookup', name);
    if (service === undefined) throw Error(`No service named ${name}`);
    return current.race(E(service)[method](...args));
  },
  async restart() {
    needClient();
    const path = statePath;
    const owns = ownedState;
    await stop();
    return start(path, owns);
  },
  async close() {
    await stop();
    if (ownedState && statePath) await rm(statePath, { recursive: true, force: true });
    statePath = undefined;
    ownedState = false;
    return true;
  },
};

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    lines.close();
    void operations.close().finally(() => process.exit(0));
  });
}
for await (const line of lines) {
  let id;
  try {
    const request = JSON.parse(line);
    ({ id } = request);
    if (typeof request.op !== 'string' || !(request.op in operations))
      throw Error('Unknown driver operation');
    const value = await operations[request.op](request);
    reply(id, { ok: true, value });
  } catch (error) {
    reply(id, { ok: false, error: { message: String(error?.message ?? error) } });
  }
}
await operations.close();
