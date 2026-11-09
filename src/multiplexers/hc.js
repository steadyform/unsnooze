// Herdr 2 backend. Herdr 2 is a desktop app on top of herdr-core, driven by the
// `hc` CLI; it is unrelated to the Herdr 1 TUI that multiplexers/herdr.js
// drives (HERDR_ENV, `herdr pane ...`).
//
// Like cmux, this backend is for an agent that is ALREADY inside a Herdr 2
// terminal (HC_TERMINAL_ID is set). The agent runs directly in that terminal,
// so its output - including the OSC 7501 status sequences Herdr 2 detects
// agents from - reaches Herdr. A tmux session in between would swallow them.
//
// A pane is a core terminal address (`t7`). The "pane owner" is the hc core
// session (HC_SESSION; `default` when unset), the thing every hc command is
// scoped by.

import { execFile as execFileCb, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

import { SessionCreateError } from './session-name.js';
import { STATE_DIR } from '../config.js';

const execFileAsync = promisify(execFileCb);

export const SUBMIT_DELAY_MS = 150;
export { SessionCreateError };

export const DEFAULT_SESSION = 'default';
const OWNER_LABEL = 'unsnooze_owner';
// The labels that make Herdr 2 show a terminal in a space and tab. A revival
// copies these from the terminal it replaces so it lands in the same place.
const HERDR_LABELS = ['herdr.space', 'herdr.tab'];
// Carries the dead terminal's address from the resumer to newWindow().
export const REOPEN_PANE_VAR = 'UNSNOOZE_REOPEN_PANE';

const PANE_RE = /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LABEL_TTL_MS = 30 * 24 * 3_600_000;

// Which core session an environment belongs to. HC_SESSION wins; a terminal's
// socket (`.../<session>.sock`) names it otherwise; unset means the default.
export function hcSession(env = process.env) {
  if (env.HC_SESSION) return env.HC_SESSION;
  const match = /([^/\\]+)\.sock$/.exec(env.HC_TERMINAL_SOCKET || '');
  return match ? match[1] : DEFAULT_SESSION;
}

function defaultSpawner(file, args, { sync = false, ...options } = {}) {
  if (sync) return spawnSync(file, args, options);
  return execFileAsync(file, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024, ...options })
    .then(({ stdout }) => stdout);
}

// hc terminal-lookup failures exit 3 with {"error":{"kind":"not_found"}}.
function isNotFound(err) {
  return err?.code === 3 || /not_found/.test(`${err?.stdout ?? ''}${err?.stderr ?? ''}`);
}

function paneArg(pane) {
  const value = String(pane ?? '');
  // A pane id that starts with '-' would be read as an option by hc.
  if (!PANE_RE.test(value)) throw new Error(`unsnooze: invalid hc terminal "${value}"`);
  return value;
}

const KEY_NAMES = {
  Enter: 'enter', Escape: 'esc', Tab: 'tab', Backspace: 'backspace',
  Up: 'up', Down: 'down', Left: 'left', Right: 'right', Space: 'space',
};

// Labels of a terminal that has been removed are gone with it, so the Herdr
// ones are also written down while the terminal still exists.
function defaultLabelStore() {
  const dir = () => join(process.env.UNSNOOZE_STATE_DIR || STATE_DIR, 'hc-labels');
  const file = (session, pane) => join(dir(),
    `${createHash('sha256').update(`${session}\0${pane}`).digest('hex')}.json`);
  return {
    save(session, pane, labels) {
      try {
        mkdirSync(dir(), { recursive: true, mode: 0o700 });
        const path = file(session, pane);
        const tmp = `${path}.tmp.${process.pid}.${randomUUID()}`;
        writeFileSync(tmp, JSON.stringify({ labels, savedAt: Date.now() }), { mode: 0o600 });
        renameSync(tmp, path);
        for (const name of readdirSync(dir())) {
          const old = join(dir(), name);
          try { if (Date.now() - statSync(old).mtimeMs > LABEL_TTL_MS) unlinkSync(old); } catch { /* raced */ }
        }
      } catch { /* bookkeeping must never fail a launch */ }
    },
    load(session, pane) {
      try { return JSON.parse(readFileSync(file(session, pane), 'utf-8')).labels || null; } catch { return null; }
    },
  };
}

export function createHc({
  spawner = defaultSpawner, env = process.env, labelStore = defaultLabelStore(),
  log = () => {},
} = {}) {
  const build = owner => {
    // Bound to a session, the command must reach exactly that core: set
    // HC_SESSION and drop the ambient terminal socket, which would otherwise
    // pin the command to whichever core the calling terminal belongs to.
    const hcEnv = () => {
      if (!owner) return env;
      const next = { ...env };
      delete next.HC_TERMINAL_SOCKET;
      if (owner === DEFAULT_SESSION) delete next.HC_SESSION;
      else next.HC_SESSION = owner;
      return next;
    };
    const session = () => owner || hcSession(env);
    const run = (args, extra = {}) => spawner('hc', args, { env: hcEnv(), ...extra });
    const getJson = async pane => JSON.parse(await run(['get', paneArg(pane), '--json']));

    const backend = {
      name: 'hc',
      SUBMIT_DELAY_MS,

      available() {
        try {
          return spawner('hc', ['--version'], { sync: true, stdio: 'ignore', env }).status === 0;
        } catch {
          return false;
        }
      },

      inside() { return !!env.HC_TERMINAL_ID; },
      currentPaneId() { return env.HC_TERMINAL_ID || null; },

      async capturePane(pane, lines = 200) {
        return run(['read', paneArg(pane), '--lines', String(lines)]);
      },

      async capturePaneVisible(pane) {
        return run(['read', paneArg(pane)]);
      },

      // Same read; `unsnooze report` feature-detects this name.
      async captureScrollback(pane, lines = 200) {
        return run(['read', paneArg(pane), '--lines', String(lines)]);
      },

      // `hc send` pastes the text and presses Enter itself (pausing while a
      // person is typing). --force: unsnooze has already decided this pane is
      // ours to type into, and a limit dialog reads as "blocked" to hc, which
      // would otherwise refuse the text.
      async sendText(pane, text) {
        await run(['send', '--force', paneArg(pane), '--', String(text)]);
      },

      async sendKey(pane, key) {
        await run(['keys', paneArg(pane), KEY_NAMES[key] || String(key).toLowerCase()]);
      },

      // A terminal that is gone (not_found) or finished is not alive. Any other
      // failure - hc missing, core unreachable - says nothing about the pane,
      // so it is thrown rather than read as death.
      async paneAlive(pane) {
        try {
          return (await getJson(pane)).state === 'live';
        } catch (err) {
          if (isNotFound(err)) return false;
          throw err;
        }
      },

      async paneCurrentCommand(pane) {
        try {
          const info = await getJson(pane);
          const fg = info.foreground;
          if (Array.isArray(fg?.argv) && fg.argv[0]) return basename(fg.argv[0].split(/\s+/)[0]);
          return fg?.name ? basename(fg.name) : null;
        } catch {
          return null;
        }
      },

      // Pane identity, as tmux's @unsnooze_owner: a label on the terminal.
      // Core terminal addresses are recycled only after removal, but the stamp
      // still proves the terminal now holds a different launch than the record.
      async stampPaneOwner(pane, leaseId) {
        try {
          await run(['label', paneArg(pane), `${OWNER_LABEL}=${leaseId}`]);
        } catch {
          return false;
        }
        try {
          const labels = (await getJson(pane)).labels || {};
          const keep = Object.fromEntries(HERDR_LABELS.filter(k => labels[k]).map(k => [k, labels[k]]));
          if (Object.keys(keep).length) labelStore.save(session(), String(pane), keep);
        } catch { /* best-effort */ }
        return true;
      },

      async paneOwnerStamp(pane) {
        try {
          const value = (await getJson(pane)).labels?.[OWNER_LABEL];
          return typeof value === 'string' && value ? value : null;
        } catch {
          return null;
        }
      },

      async sessionForPane() { return session(); },

      // The hc "session" is the core, not something unsnooze creates; it
      // exists when it answers.
      async sessionExists(name) {
        if (name !== session()) return false;
        try { await run(['ls', '--json']); return true; } catch { return false; }
      },

      // Revival: a new terminal in the same core, running the launcher. The
      // dead terminal's Herdr space/tab labels (read from it, or from the copy
      // taken at launch if it was already removed) go on the new one so Herdr
      // shows it in the same place. With no labels left it is still a real
      // terminal that unsnooze can read and type into - Herdr just does not
      // list it; `hc attach <t>` reaches it.
      async newWindow(_sessionName, cwd, launchSpec) {
        const { [REOPEN_PANE_VAR]: oldPane, ...specEnv } = launchSpec.env || {};
        let labels = null;
        if (oldPane) {
          try { labels = (await getJson(oldPane)).labels || null; } catch { /* removed */ }
          if (!labels || !HERDR_LABELS.some(k => labels[k])) {
            labels = labelStore.load(session(), String(oldPane)) || labels;
          }
        }
        const copied = HERDR_LABELS.filter(k => labels?.[k]).map(k => `${k}=${labels[k]}`);
        if (oldPane && copied.length === 0) {
          log(`hc: no Herdr labels for ${oldPane}; the revived terminal will not appear in Herdr (hc attach)`);
        }
        const envPairs = Object.entries(specEnv)
          .filter(([key, value]) => value !== undefined && ENV_NAME_RE.test(key))
          .map(([key, value]) => `${key}=${value}`);
        const out = await run([
          'run', '--bg', '--json', '--keep', '--no-parent', '--cwd', cwd,
          ...copied.flatMap(label => ['--label', label]),
          '--', 'env', ...envPairs, launchSpec.file, ...(launchSpec.args || []),
        ]);
        let parsed;
        try { parsed = JSON.parse(out); } catch {
          throw new Error(`unsnooze: unexpected hc run output: ${String(out).slice(0, 200)}`);
        }
        if (!parsed?.address) throw new Error('unsnooze: hc run returned no terminal address');
        const used = session();
        return { pane: parsed.address, paneOwner: used, session: used };
      },

      // The agent is meant to run in the terminal the user already has open;
      // there is nothing to wrap into from outside Herdr.
      launchWrapped() {
        throw new SessionCreateError(
          'hc runs agents inside an existing Herdr 2 terminal - start it from one');
      },

      async closePane(pane) {
        await run(['kill', paneArg(pane)]);
      },

      bind(nextOwner) { return build(nextOwner || null); },
    };
    return backend;
  };

  return build(null);
}

const hc = createHc();

export const available = (...args) => hc.available(...args);
export const inside = (...args) => hc.inside(...args);
export const currentPaneId = (...args) => hc.currentPaneId(...args);
export const launchWrapped = (...args) => hc.launchWrapped(...args);

export default hc;
