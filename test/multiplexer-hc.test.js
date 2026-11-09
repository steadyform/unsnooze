import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createHc, hcSession, SessionCreateError } from '../src/multiplexers/hc.js';
import { createMultiplexerFactory } from '../src/multiplexer.js';
import { resolvePaneOwner } from '../src/launcher.js';
import { hookContext } from '../src/hook.js';
import { attachHint } from '../src/multiplexers/session-name.js';

// Records every hc call; `respond(args)` supplies stdout or throws.
function fakeSpawner(respond = () => '') {
  const calls = [];
  const spawner = (file, args, options = {}) => {
    calls.push({ file, args, options });
    if (options.sync) return { status: 0 };
    try { return Promise.resolve(respond(args, options)); } catch (err) { return Promise.reject(err); }
  };
  spawner.calls = calls;
  return spawner;
}

const notFound = () => Object.assign(new Error('no terminal'), {
  code: 3, stdout: '{"error":{"kind":"not_found"}}',
});

function memStore() {
  const rows = new Map();
  return {
    rows,
    save: (s, p, labels) => rows.set(`${s}/${p}`, labels),
    load: (s, p) => rows.get(`${s}/${p}`) || null,
  };
}

const IN_HERDR = { HC_TERMINAL_ID: 't2r', HC_TERMINAL_SOCKET: '/run/user/1/herdr-core/default.sock', HC_SCOPE: 'x' };

test('hc detection: inside() and currentPaneId() follow HC_TERMINAL_ID', () => {
  const hc = createHc({ spawner: fakeSpawner(), env: IN_HERDR });
  assert.equal(hc.inside(), true);
  assert.equal(hc.currentPaneId(), 't2r');
  const outside = createHc({ spawner: fakeSpawner(), env: {} });
  assert.equal(outside.inside(), false);
  assert.equal(outside.currentPaneId(), null);
  assert.equal(hc.available(), true);
});

test('hcSession reads HC_SESSION, then the socket name, then defaults', () => {
  assert.equal(hcSession({ HC_SESSION: 'dev', HC_TERMINAL_SOCKET: '/x/other.sock' }), 'dev');
  assert.equal(hcSession({ HC_TERMINAL_SOCKET: '/run/herdr-core/unsnooze-dev.sock' }), 'unsnooze-dev');
  assert.equal(hcSession(IN_HERDR), 'default');
  assert.equal(hcSession({}), 'default');
});

test('resolveName: HC_TERMINAL_ID selects hc, but tmux/zellij/HERDR_ENV inside it win', () => {
  const mk = env => createMultiplexerFactory({
    backends: {
      tmux: { name: 'tmux', available: () => true }, zellij: { name: 'zellij', available: () => true },
      herdr: { name: 'herdr', available: () => true }, cmux: { name: 'cmux', available: () => true },
      hc: { name: 'hc', available: () => true },
    },
    getSetting: () => 'auto', env,
  }).getMultiplexer().name;
  assert.equal(mk({ HC_TERMINAL_ID: 't1' }), 'hc');
  assert.equal(mk({ HC_TERMINAL_ID: 't1', TMUX: '/tmp/tmux' }), 'tmux');
  assert.equal(mk({ HC_TERMINAL_ID: 't1', ZELLIJ: '0' }), 'zellij');
  assert.equal(mk({ HC_TERMINAL_ID: 't1', HERDR_ENV: '1' }), 'herdr');
  assert.equal(mk({ HC_TERMINAL_ID: 't1', CMUX_SOCKET_PATH: '/s' }), 'cmux');
  assert.equal(mk({}), 'tmux');
});

test('hc capture reads the terminal with hc read, history via --lines', async () => {
  const spawner = fakeSpawner(() => 'screen text');
  const hc = createHc({ spawner, env: IN_HERDR });
  assert.equal(await hc.capturePane('t3', 120), 'screen text');
  await hc.capturePaneVisible('t3');
  await hc.captureScrollback('t3', 500);
  assert.deepEqual(spawner.calls.map(c => c.args), [
    ['read', 't3', '--lines', '120'], ['read', 't3'], ['read', 't3', '--lines', '500'],
  ]);
  assert.equal(spawner.calls[0].file, 'hc');
});

test('hc sendText uses hc send (paste + Enter in one call); sendKey maps names', async () => {
  const spawner = fakeSpawner();
  const hc = createHc({ spawner, env: IN_HERDR });
  await hc.sendText('t3', '-continue please');
  await hc.sendKey('t3', 'Enter');
  await hc.sendKey('t3', 'Down');
  await hc.sendKey('t3', 'Escape');
  assert.deepEqual(spawner.calls.map(c => c.args), [
    ['send', '--force', 't3', '--', '-continue please'],
    ['keys', 't3', 'enter'], ['keys', 't3', 'down'], ['keys', 't3', 'esc'],
  ]);
});

test('hc refuses a terminal address that could be read as an option', async () => {
  const hc = createHc({ spawner: fakeSpawner(), env: IN_HERDR });
  await assert.rejects(hc.sendText('--help', 'x'), /invalid hc terminal/);
  await assert.rejects(hc.capturePane('', 5), /invalid hc terminal/);
});

test('hc paneAlive: live is alive; finished and not_found are dead; other errors throw', async () => {
  const state = { t1: '{"state":"live"}', t2: '{"state":"finished"}' };
  const hc = createHc({
    env: IN_HERDR,
    spawner: fakeSpawner(args => {
      if (args[1] === 'gone') throw notFound();
      if (args[1] === 'broken') throw Object.assign(new Error('core down'), { code: 1 });
      return state[args[1]];
    }),
  });
  assert.equal(await hc.paneAlive('t1'), true);
  assert.equal(await hc.paneAlive('t2'), false);
  assert.equal(await hc.paneAlive('gone'), false);
  await assert.rejects(hc.paneAlive('broken'), /core down/);
});

test('hc paneCurrentCommand reads the foreground program from hc get', async () => {
  const get = fg => createHc({ env: IN_HERDR, spawner: fakeSpawner(() => JSON.stringify({ foreground: fg })) });
  assert.equal(await get({ argv: ['/usr/bin/codex', '--x'], name: 'node' }).paneCurrentCommand('t1'), 'codex');
  assert.equal(await get({ name: 'bash' }).paneCurrentCommand('t1'), 'bash');
  assert.equal(await get(undefined).paneCurrentCommand('t1'), null);
});

test('hc stamps and reads the owner as a terminal label; snapshots Herdr labels', async () => {
  const store = memStore();
  const spawner = fakeSpawner(args => (args[0] === 'get'
    ? JSON.stringify({ labels: { 'herdr.space': 's1', 'herdr.tab': 'b2', unsnooze_owner: 'lease-1', other: 'x' } })
    : ''));
  const hc = createHc({ spawner, env: IN_HERDR, labelStore: store });
  assert.equal(await hc.stampPaneOwner('t3', 'lease-1'), true);
  assert.deepEqual(spawner.calls[0].args, ['label', 't3', 'unsnooze_owner=lease-1']);
  assert.deepEqual(store.load('default', 't3'), { 'herdr.space': 's1', 'herdr.tab': 'b2' });
  assert.equal(await hc.paneOwnerStamp('t3'), 'lease-1');
  const bare = createHc({ spawner: fakeSpawner(() => '{"labels":{}}'), env: IN_HERDR });
  assert.equal(await bare.paneOwnerStamp('t3'), null);
  const failing = createHc({ spawner: fakeSpawner(() => { throw new Error('x'); }), env: IN_HERDR });
  assert.equal(await failing.stampPaneOwner('t3', 'l'), false);
});

test('bind(owner) targets that core session and drops the ambient terminal socket', async () => {
  const spawner = fakeSpawner();
  const hc = createHc({ spawner, env: { ...IN_HERDR, HC_SESSION: 'ambient' } });
  await hc.bind('dev').capturePaneVisible('t1');
  await hc.bind('default').capturePaneVisible('t1');
  await hc.capturePaneVisible('t1');
  const [dev, def, unbound] = spawner.calls.map(c => c.options.env);
  assert.equal(dev.HC_SESSION, 'dev');
  assert.equal(dev.HC_TERMINAL_SOCKET, undefined);
  assert.equal(def.HC_SESSION, undefined);
  assert.equal(unbound.HC_SESSION, 'ambient');
  assert.equal(await hc.bind('dev').sessionForPane('t1'), 'dev');
  assert.equal(await hc.sessionForPane('t1'), 'ambient');
});

test('sessionExists is true only for the reachable bound core', async () => {
  const ok = createHc({ spawner: fakeSpawner(() => '{}'), env: IN_HERDR });
  assert.equal(await ok.sessionExists('default'), true);
  assert.equal(await ok.sessionExists('unsnooze'), false);
  const down = createHc({ spawner: fakeSpawner(() => { throw new Error('refused'); }), env: IN_HERDR });
  assert.equal(await down.sessionExists('default'), false);
});

test('newWindow runs the launcher in a new labeled terminal of the same core', async () => {
  const spawner = fakeSpawner(args => (args[0] === 'get'
    ? JSON.stringify({ labels: { 'herdr.space': 's1', 'herdr.tab': 'b2', unsnooze_owner: 'old' } })
    : '{"address":"t9","state":"live"}'));
  const hc = createHc({ spawner, env: IN_HERDR, labelStore: memStore() }).bind('default');
  const address = await hc.newWindow('unsnooze-resume', '/work', {
    file: '/usr/bin/node', args: ['u.js', '_run', 'codex', 'resume'],
    env: { UNSNOOZE_MUX: 'hc', UNSNOOZE_REOPEN_PANE: 't3', 'BAD NAME': 'x', UNSNOOZE_LEASE_ID: 'L' },
  });
  assert.deepEqual(address, { pane: 't9', paneOwner: 'default', session: 'default' });
  const run = spawner.calls.find(c => c.args[0] === 'run').args;
  assert.deepEqual(run, [
    'run', '--bg', '--json', '--keep', '--no-parent', '--cwd', '/work',
    '--label', 'herdr.space=s1', '--label', 'herdr.tab=b2',
    '--', 'env', 'UNSNOOZE_MUX=hc', 'UNSNOOZE_LEASE_ID=L',
    '/usr/bin/node', 'u.js', '_run', 'codex', 'resume',
  ]);
});

test('newWindow falls back to the labels saved at launch when the old terminal was removed', async () => {
  const store = memStore();
  store.save('default', 't3', { 'herdr.space': 's7', 'herdr.tab': 'b8' });
  const spawner = fakeSpawner(args => { if (args[0] === 'get') throw notFound(); return '{"address":"t4"}'; });
  const hc = createHc({ spawner, env: IN_HERDR, labelStore: store });
  await hc.newWindow('x', '/w', { file: 'f', args: [], env: { UNSNOOZE_REOPEN_PANE: 't3' } });
  const run = spawner.calls.find(c => c.args[0] === 'run').args;
  assert.deepEqual(run.slice(run.indexOf('--label')), [
    '--label', 'herdr.space=s7', '--label', 'herdr.tab=b8', '--', 'env', 'f']);
});

test('newWindow with no labels anywhere still opens an unlabeled terminal and says so', async () => {
  const logs = [];
  const spawner = fakeSpawner(args => { if (args[0] === 'get') throw notFound(); return '{"address":"t4"}'; });
  const hc = createHc({ spawner, env: IN_HERDR, labelStore: memStore(), log: m => logs.push(m) });
  const address = await hc.newWindow('x', '/w', { file: 'f', args: ['a'], env: { UNSNOOZE_REOPEN_PANE: 't3' } });
  assert.equal(address.pane, 't4');
  assert.equal(spawner.calls.find(c => c.args[0] === 'run').args.includes('--label'), false);
  assert.match(logs[0], /will not appear in Herdr/);
});

test('newWindow surfaces a failed or malformed hc run', async () => {
  const bad = createHc({ spawner: fakeSpawner(() => 'nope'), env: IN_HERDR, labelStore: memStore() });
  await assert.rejects(bad.newWindow('x', '/w', { file: 'f' }), /unexpected hc run output/);
  const none = createHc({ spawner: fakeSpawner(() => '{}'), env: IN_HERDR, labelStore: memStore() });
  await assert.rejects(none.newWindow('x', '/w', { file: 'f' }), /no terminal address/);
});

test('launchWrapped from outside Herdr is a SessionCreateError; closePane kills the terminal', async () => {
  const spawner = fakeSpawner();
  const hc = createHc({ spawner, env: IN_HERDR });
  assert.throws(() => hc.launchWrapped(), SessionCreateError);
  await hc.closePane('t3');
  assert.deepEqual(spawner.calls[0].args, ['kill', 't3']);
});

test('pane owner plumbing: launcher, hook and attach hint treat hc as an hc-core session', () => {
  assert.equal(resolvePaneOwner('hc', IN_HERDR), 'default');
  assert.equal(resolvePaneOwner('hc', { HC_SESSION: 'dev' }), 'dev');
  assert.equal(resolvePaneOwner('hc', { UNSNOOZE_MUX: 'hc', UNSNOOZE_PANE_OWNER: 'dev2', HC_SESSION: 'x' }), 'dev2');
  assert.deepEqual(hookContext(IN_HERDR), { muxName: 'hc', pane: 't2r', paneOwner: 'default' });
  assert.equal(hookContext({ ...IN_HERDR, TMUX: '/t,1,0', TMUX_PANE: '%1' }).muxName, 'tmux');
  assert.equal(attachHint('hc', 'default'), null);
});
