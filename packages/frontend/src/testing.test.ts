import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const harness = JSON.stringify(import.meta.dir + '/testing.cjs');

function runFixture(source: string, nextFile?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'tableau-ai-eval-dom-test-'));
  try {
    const first = join(dir, 'browser.test.ts');
    writeFileSync(first, source);
    const files = [first];
    if (nextFile) {
      const second = join(dir, 'server.test.ts');
      writeFileSync(second, nextFile);
      files.push(second);
    }
    const result = Bun.spawnSync([process.execPath, 'test', ...files], {
      cwd: dir,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 10_000,
    });
    return {
      exitCode: result.exitCode,
      output: new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('browser timer exceptions fail bun test instead of merely being logged', () => {
  const result = runFixture(`
    import { test } from 'bun:test';
    const nativeSetTimeout = globalThis.setTimeout;
    require(${harness});
    test('timer failure', async () => {
      window.setTimeout(() => { throw new Error('browser timer regression'); }, 0);
      await new Promise(resolve => nativeSetTimeout(resolve, 30));
    });
  `);
  expect(result.output).toContain('browser timer regression');
  expect(result.exitCode).not.toBe(0);
});

test('browser event handler exceptions fail bun test', () => {
  const result = runFixture(`
    import { test } from 'bun:test';
    require(${harness});
    test('event failure', () => {
      const button = document.createElement('button');
      button.addEventListener('click', () => { throw new Error('browser event regression'); });
      button.click();
    });
  `);
  expect(result.output).toContain('browser event regression');
  expect(result.exitCode).not.toBe(0);
});

test('DOM teardown cancels timers before restoring server globals', () => {
  const result = runFixture(`
    import { test } from 'bun:test';
    require(${harness});
    test('pending browser work', () => {
      window.setTimeout(() => { throw new Error('leaked browser timer'); }, 50);
      window.setInterval(() => { throw new Error('leaked browser interval'); }, 50);
    });
  `, `
    import { expect, test } from 'bun:test';
    test('server globals restored', async () => {
      expect(typeof window).toBe('undefined');
      await new Promise(resolve => setTimeout(resolve, 100));
    });
  `);
  expect(result.output).not.toContain('leaked browser');
  expect(result.exitCode).toBe(0);
});
