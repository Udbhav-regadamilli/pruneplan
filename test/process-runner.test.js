import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { run, runPackageManager, runWindowsShim } from '../bin/process-runner.js';

test('JSON mode emits standalone versioned JSON for clean and findings reports', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pruneplan json report-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const cliPath = fileURLToPath(new URL('../bin/pruneplan.js', import.meta.url));
  const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  for (const [name, dependencies] of [['clean', {}], ['findings', { 'unused-package': '1.0.0' }]]) {
    const directory = path.join(root, name);
    await mkdir(directory);
    const packageJson = { name: 'json-' + name, version: '1.0.0', main: 'index.js', dependencies };
    await writeFile(path.join(directory, 'package.json'), JSON.stringify(packageJson, null, 2) + '\n');
    const lock = { name: packageJson.name, version: packageJson.version, lockfileVersion: 3, requires: true, packages: { '': { name: packageJson.name, version: packageJson.version } } };
    await writeFile(path.join(directory, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n');
    await writeFile(path.join(directory, 'index.js'), 'export const ready = true;\n');

    const result = spawnSync(process.execPath, [cliPath, directory, '--json'], { cwd: packageRoot, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.doesNotMatch(result.stdout, /^Scanning /m);
    const report = JSON.parse(result.stdout);
    assert.equal(report.schemaVersion, 1);
    assert.ok(Array.isArray(report.candidates));
    if (name === 'findings') assert.ok(report.candidates.some((item) => item.kind === 'dependency' && item.name === 'unused-package'));
  }
});

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
    assert.equal(result.stdout.trim(), `${manager} "uninstall" "@scope/pkg@^1.2.3"`);
  }

  await writeFile(path.join(binDirectory, 'knip.cmd'), '@echo off\r\necho knip %*\r\n');
  const knip = runWindowsShim('knip.cmd', ['--config', 'knip config.json'], directory, { capture: true });
  assert.equal(knip.status, 0, knip.stderr);
  assert.equal(knip.stdout.trim(), 'knip "--config" "knip config.json"');
});
