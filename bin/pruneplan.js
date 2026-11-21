#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KNIP_JSON_FLAG = '--reporter';
const APPLY_FIX_TYPES = ['files', 'exports', 'types'];
const CHECK_SCRIPTS = ['typecheck', 'lint', 'test', 'build'];

function parseArgs(argv) {
  const options = { apply: false, yes: false, directory: process.cwd() };
  let hasDirectory = false;

  for (const arg of argv) {
    if (arg === '--apply') options.apply = true;
    else if (arg === '--yes' || arg === '-y') {
      options.apply = true;
      options.yes = true;
    } else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else if (hasDirectory) throw new Error('Only one project path can be supplied.');
    else {
      options.directory = path.resolve(arg);
      hasDirectory = true;
    }
  }

  return options;
}

function printHelp() {
  stdout.write(`pruneplan — review unused dependencies and dead code\n\n`);
  stdout.write(`Usage:\n  pruneplan [project-directory] [--apply] [--yes]\n\n`);
  stdout.write(`Options:\n`);
  stdout.write(`  --apply   Apply the displayed cleanup plan after confirmation\n`);
  stdout.write(`  --yes     Apply without an interactive confirmation (for automation)\n`);
  stdout.write(`  -h, --help  Show this help\n\n`);
  stdout.write(`Knip is included with pruneplan; no project setup is required.\n`);
}

async function readProject(directory) {
  const packagePath = path.join(directory, 'package.json');
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
  return { packagePath, packageJson };
}

async function detectPackageManager(directory, packageJson) {
  const lockfiles = [
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lock', 'bun'],
    ['bun.lockb', 'bun'],
    ['package-lock.json', 'npm'],
    ['npm-shrinkwrap.json', 'npm'],
  ];

  for (const [file, manager] of lockfiles) {
    try {
      await access(path.join(directory, file));
      return manager;
    } catch {}
  }

  const declared = packageJson.packageManager?.split('@')[0];
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(declared)) return declared;
  throw new Error('Could not detect the package manager. Add a lockfile or packageManager field to package.json.');
}

function run(command, args, cwd, { capture = false } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    shell: process.platform === 'win32',
  });

  if (result.error) throw new Error(`${command} could not be started: ${result.error.message}`);
  return result;
}

async function findKnip(directory) {
  let current = directory;
  while (true) {
    const localBin = path.join(current, 'node_modules', '.bin', process.platform === 'win32' ? 'knip.cmd' : 'knip');
    try {
      await access(localBin);
      return { command: localBin, prefixArgs: [] };
    } catch {}

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const bundledKnip = fileURLToPath(new URL('../node_modules/knip/bin/knip.js', import.meta.url));
  try {
    await access(bundledKnip);
    return { command: process.execPath, prefixArgs: [bundledKnip] };
  } catch {}

  return { command: 'knip', prefixArgs: [] };
}

function extractIssues(output) {
  const start = output.indexOf('{');
  const end = output.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('Knip did not return JSON. Run `knip --reporter json` to inspect its output.');
  const parsed = JSON.parse(output.slice(start, end + 1));
  if (!Array.isArray(parsed.issues)) throw new Error('Knip JSON output did not include an issues array.');
  return parsed.issues;
}

function collectPlan(issues) {
  const files = [];
  const exports = [];
  const dependencies = new Map();

  for (const issue of issues) {
    for (const item of issue.files ?? []) files.push({ file: issue.file, name: item.name });
    for (const category of ['exports', 'types', 'enumMembers', 'namespaceMembers']) {
      for (const item of issue[category] ?? []) exports.push({ file: issue.file, category, name: item.name });
    }
    for (const category of ['dependencies', 'devDependencies']) {
      for (const item of issue[category] ?? []) {
        dependencies.set(item.name, { name: item.name, category, file: issue.file });
      }
    }
  }

  return { files, exports, dependencies: [...dependencies.values()] };
}

function displayPlan(plan, manager) {
  const total = plan.files.length + plan.exports.length + plan.dependencies.length;
  stdout.write(`\nPruneplan found ${total} cleanup candidate${total === 1 ? '' : 's'}.\n`);
  if (total === 0) {
    stdout.write('Your project looks tidy.\n');
    return;
  }

  if (plan.dependencies.length) {
    stdout.write(`\nUnused packages (${plan.dependencies.length}) — will be removed with ${manager}:\n`);
    for (const item of plan.dependencies) stdout.write(`  • ${item.name} (${item.category})\n`);
  }
  if (plan.files.length) {
    stdout.write(`\nUnused files (${plan.files.length}) — Knip can delete these:\n`);
    for (const item of plan.files) stdout.write(`  • ${item.file}\n`);
  }
  if (plan.exports.length) {
    stdout.write(`\nUnused exports and types (${plan.exports.length}) — Knip can remove these:\n`);
    for (const item of plan.exports) stdout.write(`  • ${item.name} in ${item.file}\n`);
  }
}

async function confirmApply() {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error('Applying in a non-interactive terminal requires the explicit `--yes` flag.');
  }
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await prompt.question('\nApply this cleanup plan? [y/N] ');
    return answer.trim().toLowerCase() === 'y';
  } finally {
    prompt.close();
  }
}

function managerRemoveArgs(manager, packages) {
  switch (manager) {
    case 'npm': return ['uninstall', ...packages, '--ignore-scripts'];
    case 'pnpm': return ['remove', ...packages, '--ignore-scripts'];
    case 'yarn': return ['remove', ...packages];
    case 'bun': return ['remove', ...packages];
    default: throw new Error(`Unsupported package manager: ${manager}`);
  }
}

async function runChecks(directory, packageJson) {
  const scripts = packageJson.scripts ?? {};
  const available = CHECK_SCRIPTS.filter((name) => typeof scripts[name] === 'string');
  if (!available.length) {
    stdout.write('\nNo typecheck, lint, test, or build scripts found; skipped validation.\n');
    return true;
  }

  const manager = await detectPackageManager(directory, packageJson);
  stdout.write(`\nRunning project checks with ${manager}: ${available.join(', ')}\n`);
  for (const name of available) {
    const args = manager === 'npm' ? ['run', name] : ['run', name];
    const result = run(manager, args, directory);
    if (result.status !== 0) {
      stdout.write(`\nValidation failed at \`${name}\`. Review the changes with git diff.\n`);
      return false;
    }
  }
  return true;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return printHelp();

  const directory = path.resolve(options.directory);
  const { packageJson } = await readProject(directory);
  const manager = await detectPackageManager(directory, packageJson);
  const knip = await findKnip(directory);

  stdout.write(`Scanning ${path.relative(process.cwd(), directory) || '.'} with Knip…\n`);
  const scan = run(knip.command, [...knip.prefixArgs, KNIP_JSON_FLAG, 'json', '--no-exit-code'], directory, { capture: true });
  if (scan.status !== 0) {
    const details = scan.stderr.trim();
    throw new Error(details || 'Knip failed. Check its configuration and try again.');
  }

  const plan = collectPlan(extractIssues(scan.stdout));
  displayPlan(plan, manager);
  const total = plan.files.length + plan.exports.length + plan.dependencies.length;
  if (!total || !options.apply) {
    if (total && !options.apply) stdout.write('\nPreview only. Run with --apply to make these changes.\n');
    return;
  }

  if (!options.yes && !(await confirmApply())) {
    stdout.write('No files changed.\n');
    return;
  }

  if (plan.dependencies.length) {
    const names = [...new Set(plan.dependencies.map(({ name }) => name))];
    stdout.write(`\nRemoving ${names.length} unused package${names.length === 1 ? '' : 's'}…\n`);
    const result = run(manager, managerRemoveArgs(manager, names), directory);
    if (result.status !== 0) throw new Error('Package manager removal failed. Review the current working tree before continuing.');
  }

  if (plan.files.length || plan.exports.length) {
    stdout.write('\nRemoving dead files and exports with Knip…\n');
    const args = ['--fix', '--no-exit-code', '--fix-type', APPLY_FIX_TYPES.join(',')];
    if (plan.files.length) args.push('--allow-remove-files');
    const result = run(knip.command, [...knip.prefixArgs, ...args], directory);
    if (result.status !== 0) throw new Error('Knip could not apply all code fixes. Review the current working tree before continuing.');
  }

  const checksPassed = await runChecks(directory, packageJson);
  stdout.write('\nCleanup applied. Review the result with `git diff` before committing.\n');
  if (!checksPassed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`pruneplan: ${error.message}`);
  process.exitCode = 1;
});
