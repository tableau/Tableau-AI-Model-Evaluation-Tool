/**
 * `@testing-library/react` with a browser DOM, for the frontend's
 * component tests under `bun test`, providing the DOM before test imports.
 *
 * A component test imports from here instead of from `@testing-library/react`.
 * Bun evaluates a test file's CommonJS dependencies before the file's own
 * imports run, so registering the DOM from a separate side-effect import is
 * too late: testing-library's `screen` binds to `document.body` when it loads.
 * Requiring it from here, after the DOM is installed, gets the order right.
 *
 * The DOM is removed after the importing file's tests: `bun test` runs every
 * package's tests in one process, and happy-dom replaces globals (`fetch`,
 * `Response`, ...) that the server tests rely on. One happy-dom window is
 * created for the whole process and only its globals are installed and
 * removed, so the `screen` testing-library bound on first load stays valid.
 * This module drops itself from the require cache after each file, so the
 * next component test file to import it installs the DOM again.
 */
const { afterAll, afterEach } = require('bun:test');
const { GlobalRegistrator } = require('@happy-dom/global-registrator');

const STASH = Symbol.for('tableau-ai-eval.testing.happyDomGlobals');

function install() {
  const stash = globalThis[STASH];
  if (!stash) {
    const before = new Map();
    for (const key of Reflect.ownKeys(globalThis)) {
      before.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    }
    // jsdom never fetches external scripts; happy-dom logs an error for each
    // one it refuses (the dashboard panel's Tableau Embedding API script).
    GlobalRegistrator.register({
      url: 'http://localhost/',
      settings: {
        handleDisabledFileLoadingAsSuccess: true,
        // Browser-style catch-and-log hides runtime exceptions from bun test.
        disableErrorCapturing: true,
      },
    });
    const dom = new Map();
    const original = new Map();
    for (const key of Reflect.ownKeys(globalThis)) {
      const now = Object.getOwnPropertyDescriptor(globalThis, key);
      const was = before.get(key);
      if (!was || was.value !== now.value || was.get !== now.get) {
        dom.set(key, now);
        original.set(key, was);
      }
    }
    globalThis[STASH] = { dom, original, installed: true };
    return;
  }
  if (stash.installed) return;
  for (const [key, desc] of stash.dom) Object.defineProperty(globalThis, key, desc);
  stash.installed = true;
}

function uninstall() {
  const stash = globalThis[STASH];
  if (!stash || !stash.installed) return;
  for (const [key, desc] of stash.original) {
    if (desc) Object.defineProperty(globalThis, key, desc);
    else delete globalThis[key];
  }
  stash.installed = false;
}

install();
// React's act() warns unless the environment says it is a test environment.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const rtl = require('@testing-library/react');

// testing-library registers its auto-cleanup once, when it first loads, so a
// later test file has to unmount its own renders.
afterEach(async () => {
  try {
    const { message } = await import('./ui/overlays.tsx');
    rtl.act(() => message.destroy());
  } finally {
    try {
      rtl.cleanup();
    } finally {
      // Unmount first so effects can clean up; then cancel leftover browser work.
      await window.happyDOM.abort();
    }
  }
});

afterAll(async () => {
  try {
    await window.happyDOM.abort();
  } finally {
    uninstall();
    delete require.cache[__filename];
  }
});

module.exports = rtl;
