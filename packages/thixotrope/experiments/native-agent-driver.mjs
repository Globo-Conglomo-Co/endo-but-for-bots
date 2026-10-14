#!/usr/bin/env node
// JSONL control for a model-driven agent whose loop runs in an Ironhorse vat.
import '@endo/init';
import { E, Far } from '@endo/far';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { performance } from 'node:perf_hooks';
import { clearTimeout, setTimeout } from 'node:timers';
import process from 'node:process';

import { installGuestSource } from './eval-source-policy.mjs';
import { connectLocalControl } from '../src/control/local-control.js';
import { serveThixotrope } from '../src/control/supervisor.js';
import { makeNodePowers } from '../src/platform/node/powers.js';
import { makeLogPowers } from '../src/platform/logging.js';

const platform = {
  ...makeNodePowers(),
  logging: makeLogPowers({
    log: (...args) => console.error(...args),
    info: (...args) => { if (process.env.THIXOTROPE_TRACE) console.error(...args); },
    error: (...args) => console.error(...args),
  }),
};
let supervisor;
let client;
let statePath;
let ownedState = false;
let modelConfig;
let scriptCursor = 0;
let modelAbort;
let injectInvalidPending = false;
const activeTurns = new Set();

const reply = (id, payload) => process.stdout.write(`${JSON.stringify({ id, ...payload })}\n`);
const needClient = () => {
  if (!client) throw Error('Start the native driver first');
  return client;
};
const invoke = async (name, method, args = []) => {
  const held = await needClient().call('lookup', name);
  if (held === undefined) throw Error(`No installed ${name}`);
  return needClient().race(E(held)[method](...args));
};
const installFile = async (name, filename, grants = []) => installGuestSource({
  name,
  source: await readFile(new URL(filename, import.meta.url), 'utf8'),
  grants,
  sourceUrl: import.meta.url,
  writeFile,
  bundle: path => platform.bundler.bundle(path),
  install: (key, bundle, namedGrants) => needClient().call('install', key, bundle, namedGrants),
  removeFile: rm,
});
const stop = async () => {
  modelAbort?.abort();
  modelAbort = undefined;
  client?.close();
  client = undefined;
  if (supervisor) {
    await supervisor.close();
    supervisor = undefined;
  }
};
const start = async (path, owns) => {
  const before = performance.now();
  statePath = path;
  ownedState = owns;
  supervisor = await serveThixotrope(platform, path);
  client = await connectLocalControl(platform, join(path, 'control.sock'));
  return { statePath: path, startupMs: Math.round(performance.now() - before) };
};
const validateModel = spec => {
  if (spec?.kind === 'scripted' && Array.isArray(spec.responses) && spec.responses.length <= 32) return spec;
  if (spec?.kind === 'local-http' && typeof spec.model === 'string' &&
      typeof spec.baseUrl === 'string') {
    const url = new URL(spec.baseUrl);
    if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
        url.username || url.password) throw Error('Model endpoint must be plain local HTTP without credentials');
    if (spec.injectInvalidOnce !== undefined && typeof spec.injectInvalidOnce !== 'boolean')
      throw Error('injectInvalidOnce must be a boolean');
    return { kind: spec.kind, model: spec.model, baseUrl: url.href, injectInvalidOnce: !!spec.injectInvalidOnce };
  }
  throw Error('Expected scripted responses or an explicit local HTTP model');
};
const hostComplete = async request => {
  if (!modelConfig) throw Error('Model is not bound');
  if (injectInvalidPending) {
    injectInvalidPending = false;
    return harden({ kind: 'tool', name: 'unsupported-test-action', args: [1] });
  }
  if (modelConfig.kind === 'scripted') {
    if (scriptCursor >= modelConfig.responses.length) throw Error('Scripted model exhausted');
    const { delayMs = 0, ...action } = modelConfig.responses[scriptCursor];
    scriptCursor += 1;
    if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 10_000) throw Error('Invalid scripted model delay');
    if (delayMs) {
      modelAbort = new AbortController();
      try {
        await new Promise((finishDelay, reject) => {
          const timer = setTimeout(finishDelay, delayMs);
          modelAbort.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(Error('Scripted model call cancelled'));
          }, { once: true });
        });
      } finally { modelAbort = undefined; }
    }
    return harden(action);
  }
  modelAbort = new AbortController();
  const timer = setTimeout(() => modelAbort?.abort(), 30_000);
  try {
    const url = new URL('/v1/chat/completions', modelConfig.baseUrl);
    const messages = [
      { role: 'system', content: 'Return one JSON object only: {"kind":"tool","name":"add","args":[integer]} or {"kind":"answer","text":"..."}. Use the add tool when arithmetic needs it. No markdown.' },
      { role: 'user', content: JSON.stringify(request) },
    ];
    const response = await globalThis.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: modelConfig.model, messages, temperature: 0 }),
      signal: modelAbort.signal,
    });
    if (!response.ok) throw Error(`Local model HTTP ${response.status}`);
    const body = await response.json();
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.length > 8000) throw Error('Invalid local model response');
    return harden(JSON.parse(content));
  } finally {
    clearTimeout(timer);
    modelAbort = undefined;
  }
};
const bindModel = async spec => {
  if (spec !== undefined) {
    modelConfig = validateModel(spec);
    scriptCursor = 0;
    injectInvalidPending = !!modelConfig.injectInvalidOnce;
  }
  if (!modelConfig) throw Error('Bind an explicit model first');
  const model = Far('HostModelOnly', { complete: hostComplete });
  await invoke('native-model-broker', 'bind', [model]);
  return { bound: modelConfig.kind };
};

const operations = {
  async start({ statePath: requestedPath }) {
    if (client) throw Error('Driver already started');
    const owns = requestedPath === undefined;
    const path = owns ? await mkdtemp(join(tmpdir(), 'thix-native-agent-')) : resolve(requestedPath);
    if (!owns) await mkdir(path, { recursive: true, mode: 0o700 });
    return start(path, owns);
  },
  async provision() {
    needClient();
    const before = performance.now();
    await installFile('native-model-broker', './native-model-broker-guest.mjs');
    const facet = await invoke('native-model-broker', 'model');
    await needClient().call('keep', 'native-model-facet', facet);
    await installFile('native-add-tool', './native-tool-guest.mjs');
    await installFile('native-agent', './native-agent-guest.mjs', [
      ['model', 'native-model-facet'], ['tool', 'native-add-tool'],
    ]);
    return { provisioned: true, provisionMs: Math.round(performance.now() - before) };
  },
  async bindModel({ model }) { return bindModel(model); },
  async run({ turnId, prompt, maxSteps = 4 }) {
    if (activeTurns.has(turnId)) throw Error('Turn is already running');
    activeTurns.add(turnId);
    const before = performance.now();
    try {
      const turn = await invoke('native-agent', 'run', [turnId, prompt, maxSteps]);
      return { turn, operationMs: Math.round(performance.now() - before) };
    } finally { activeTurns.delete(turnId); }
  },
  async status({ turnId }) { return invoke('native-agent', 'status', [turnId]); },
  async cancel({ turnId }) {
    const cancelled = await invoke('native-agent', 'cancel', [turnId]);
    if (cancelled) modelAbort?.abort();
    return cancelled;
  },
  async toolRead() { return invoke('native-add-tool', 'read'); },
  async restart() {
    needClient();
    const path = statePath;
    const owns = ownedState;
    await stop();
    const result = await start(path, owns);
    if (modelConfig) await bindModel();
    return { restartMs: result.startupMs, rebound: !!modelConfig };
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
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  lines.close();
  void operations.close().finally(() => process.exit(0));
});
const inFlight = new Set();
for await (const line of lines) {
  const work = (async () => {
    let id;
    try {
      const request = JSON.parse(line);
      ({ id } = request);
      if (typeof request.op !== 'string' || !(request.op in operations)) throw Error('Unknown operation');
      const value = await operations[request.op](request);
      reply(id, { ok: true, value });
    } catch (error) {
      reply(id, { ok: false, error: { message: error instanceof Error ? error.message : String(error) } });
    }
  })();
  inFlight.add(work);
  void work.finally(() => inFlight.delete(work));
}
await Promise.allSettled(inFlight);
await operations.close();
