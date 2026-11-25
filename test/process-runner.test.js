import assert from 'node:assert/strict';
import { copyFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { run, runPackageManager, runWindowsShim } from '../bin/process-runner.js';

test('direct Node execution handles executable and script paths containing spaces', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pruneplan path with spaces-'));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const nodePath = path.join(directory, 'node executable.exe');
  const scriptPath = path.join(directory, 'knip scripts', 'scan project.js');
  await copyFile(process.execPath, nodePath);
  await mkdir(path.dirname(scriptPath));
  await writeFile(scriptPath, 'process.stdout.write("knip ran");\n');

  const result = run(nodePath, [scriptPath], directory, { capture: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'knip ran');
});

test('Windows package-manager and global Knip shims work from a PATH directory with spaces', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pruneplan command shims-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const binDirectory = path.join(directory, 'shim directory with spaces');
  await mkdir(binDirectory);

  const previousPath = process.env.PATH;
  process.env.PATH = `${binDirectory}${path.delimiter}${previousPath ?? ''}`;
  t.after(() => { process.env.PATH = previousPath; });

  for (const manager of ['npm', 'pnpm', 'yarn', 'bun']) {
    await writeFile(path.join(binDirectory, `${manager}.cmd`), `@echo off\r\necho ${manager} %*\r\n`);
    const result = runPackageManager(manager, ['uninstall', '@scope/pkg@^1.2.3'], directory, { capture: true });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), `${manager} uninstall @scope/pkg@^1.2.3`);
  }

  await writeFile(path.join(binDirectory, 'knip.cmd'), '@echo off\r\necho knip %*\r\n');
  const knip = runWindowsShim('knip.cmd', ['--config', 'knip config.json'], directory, { capture: true });
  assert.equal(knip.status, 0, knip.stderr);
  assert.equal(knip.stdout.trim(), 'knip --config knip config.json');
});
