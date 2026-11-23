#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { access, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CHECK_SCRIPTS = ['typecheck', 'lint', 'test', 'build'];
const AUTO_CATEGORIES = new Set(['files', 'exports', 'types', 'enumMembers', 'namespaceMembers', 'dependencies', 'devDependencies']);
const REVIEW_FIRST = /(^|[/\\])(?:eslint|prettier|vite|webpack|rollup|jest|vitest|knip|babel|postcss|tailwind|tsconfig|commitlint|lint-staged|stylelint|next|nuxt|svelte|astro|playwright|cypress)[^/\\]*\.(?:[cm]?[jt]sx?|json)$/i;

function parseArgs(argv) {
  const options = { apply: false, yes: false, json: false, directory: process.cwd() };
  let hasDirectory = false;
  for (const arg of argv) {
    if (arg === '--apply') options.apply = true;
    else if (arg === '--yes' || arg === '-y') { options.apply = true; options.yes = true; }
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else if (hasDirectory) throw new Error('Only one project path can be supplied.');
    else { options.directory = path.resolve(arg); hasDirectory = true; }
  }
  return options;
}

function printHelp() {
  stdout.write(`pruneplan — review unused dependencies and dead code\n\n`);
  stdout.write(`Usage:\n  pruneplan [project-directory] [--apply] [--yes] [--json]\n\n`);
  stdout.write(`Options:\n  --apply   Review and select individual cleanup candidates\n  --yes     Apply all safely actionable candidates without prompts\n  --json    Print the Knip findings as a JSON report\n  -h, --help  Show this help\n\n`);
}

async function readProject(directory) {
  const packageJson = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  return { packageJson };
}

async function detectPackageManager(directory, packageJson) {
  for (const [file, manager] of [['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lock', 'bun'], ['bun.lockb', 'bun'], ['package-lock.json', 'npm'], ['npm-shrinkwrap.json', 'npm']]) {
    try { await access(path.join(directory, file)); return manager; } catch {}
  }
  const declared = packageJson.packageManager?.split('@')[0];
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(declared)) return declared;
  throw new Error('Could not detect the package manager. Add a lockfile or packageManager field to package.json.');
}

function run(command, args, cwd, { capture = false } = {}) {
  const result = spawnSync(command, args, {
    cwd, encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    shell: false,
    windowsHide: true,
  });
  if (result.error) throw new Error(`${command} could not be started: ${result.error.message}`);
  return result;
}

async function findKnip(directory) {
  let current = directory;
  while (true) {
    const script = path.join(current, 'node_modules', 'knip', 'bin', 'knip.js');
    try { await access(script); return { command: process.execPath, prefixArgs: [script], source: 'project-local' }; } catch {}
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const bundled = fileURLToPath(new URL('../node_modules/knip/bin/knip.js', import.meta.url));
  try { await access(bundled); return { command: process.execPath, prefixArgs: [bundled], source: 'bundled' }; } catch {}
  return { command: 'knip', prefixArgs: [], source: 'PATH' };
}

function extractIssues(output) {
  const start = output.indexOf('{');
  const end = output.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('Knip did not return JSON. Run `knip --reporter json` to inspect its output.');
  const parsed = JSON.parse(output.slice(start, end + 1));
  if (!Array.isArray(parsed.issues)) throw new Error('Knip JSON output did not include an issues array.');
  return parsed;
}

function collectPlan(report) {
  const files = [];
  const exports = [];
  const dependencies = new Map();
  const warnings = [];
  for (const issue of report.issues) {
    const file = issue.file ?? '(project)';
    for (const item of issue.files ?? []) files.push({ kind: 'file', file, name: item.name, reason: 'Knip reported an unused file' });
    for (const category of ['exports', 'types', 'enumMembers', 'namespaceMembers']) {
      for (const item of issue[category] ?? []) exports.push({ kind: 'export', file, category, name: item.name, reason: `Knip reported an unused ${category === 'exports' ? 'export' : category}` });
    }
    for (const category of ['dependencies', 'devDependencies']) {
      for (const item of issue[category] ?? []) {
        dependencies.set(`${category}:${item.name}`, { kind: 'dependency', name: item.name, category, file, reason: `Knip reported an unused ${category === 'dependencies' ? 'dependency' : 'dev dependency'}` });
      }
    }
    for (const [category, items] of Object.entries(issue)) {
      if (category === 'file' || AUTO_CATEGORIES.has(category) || !Array.isArray(items) || !items.length) continue;
      for (const item of items) warnings.push({ category, file, name: item.name ?? item.dependency ?? JSON.stringify(item) });
    }
  }
  const candidates = [...dependencies.values(), ...files, ...exports];
  candidates.forEach((item, index) => { item.id = index + 1; item.reviewFirst = item.kind === 'file' && REVIEW_FIRST.test(item.file); });
  return { files, exports, dependencies: [...dependencies.values()], warnings, candidates };
}

function planSummary(plan) {
  return JSON.stringify(plan.candidates.map(({ kind, file, name, category }) => [kind, file, name, category]).sort());
}

function displayPlan(plan, manager, knip) {
  stdout.write(`\nKnip ${knip.version ?? 'version unavailable'} (${knip.source}) found ${plan.candidates.length} cleanup candidate${plan.candidates.length === 1 ? '' : 's'}.\n`);
  if (!plan.candidates.length) stdout.write('No supported cleanup candidates found.\n');
  for (const item of plan.candidates) {
    const target = item.kind === 'dependency' ? `${item.name} (${item.category}, ${manager})` : item.kind === 'file' ? item.file : `${item.name} in ${item.file} (${item.category})`;
    const action = item.kind === 'export' ? 'manual review only' : 'selectable';
    stdout.write(`  ${item.id}. [${item.kind}; ${action}] ${target}${item.reviewFirst ? ' — configuration-like file: review carefully' : ''}\n`);
  }
  if (plan.warnings.length) {
    stdout.write(`\nKnip warnings (${plan.warnings.length}) — review manually; pruneplan will not change these:\n`);
    for (const warning of plan.warnings) stdout.write(`  • ${warning.category}${warning.name ? `: ${warning.name}` : ''}${warning.file !== '(project)' ? ` in ${warning.file}` : ''}\n`);
  }
}

async function promptLine(question) {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('Applying in a non-interactive terminal requires `--yes`.');
  const prompt = createInterface({ input: stdin, output: stdout });
  try { return await prompt.question(question); } finally { prompt.close(); }
}

async function selectCandidates(plan, yes) {
  const selectable = plan.candidates.filter((item) => item.kind !== 'export');
  if (yes) return selectable.filter((item) => !item.reviewFirst);
  if (!selectable.length) return [];
  stdout.write('\nChoose item numbers to apply, separated by commas (or press Enter for none). Configuration-like files require explicit selection.\n');
  const answer = (await promptLine('Apply: ')).trim();
  if (!answer) return [];
  if (answer.toLowerCase() === 'all') return selectable;
  const numbers = answer.split(',').map((part) => part.trim());
  if (numbers.some((part) => !/^\d+$/.test(part))) throw new Error('Enter comma-separated item numbers or `all`.');
  const ids = new Set(numbers.map(Number));
  if (ids.size !== numbers.length || [...ids].some((id) => !selectable.some((item) => item.id === id))) throw new Error('Selection includes an invalid or duplicate item number.');
  return selectable.filter((item) => ids.has(item.id));
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

async function getDirtyStatus(directory) {
  const result = run('git', ['status', '--porcelain'], directory, { capture: true });
  if (result.status !== 0) return null;
  return result.stdout.trim().length > 0;
}

function safeProjectPath(directory, file) {
  const absolute = path.resolve(directory, file);
  const relative = path.relative(directory, absolute);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new Error(`Refusing to remove a path outside the project: ${file}`);
  return absolute;
}

async function removeSelectedFiles(directory, selected) {
  for (const item of selected.filter((candidate) => candidate.kind === 'file')) {
    const target = safeProjectPath(directory, item.file);
    const statEntries = await readdir(path.dirname(target));
    if (!statEntries.includes(path.basename(target))) throw new Error(`File no longer exists; no further changes applied: ${item.file}`);
    await rm(target, { force: false });
    stdout.write(`Removed ${item.file}\n`);
  }
}

async function runChecks(directory, packageJson) {
  const available = CHECK_SCRIPTS.filter((name) => typeof packageJson.scripts?.[name] === 'string');
  if (!available.length) { stdout.write('\nNo typecheck, lint, test, or build scripts found; skipped validation.\n'); return true; }
  const manager = await detectPackageManager(directory, packageJson);
  stdout.write(`\nRunning checks with ${manager}: ${available.join(', ')}\n`);
  for (const name of available) {
    const result = run(manager, ['run', name], directory);
    if (result.status !== 0) { stdout.write(`\nValidation failed at \`${name}\`. Changes remain in the working tree; inspect with git diff.\n`); return false; }
  }
  return true;
}

async function scanProject(directory, knip) {
  const result = run(knip.command, [...knip.prefixArgs, '--reporter', 'json', '--no-exit-code'], directory, { capture: true });
  if (result.status !== 0) throw new Error(result.stderr.trim() || 'Knip scan failed. Check its configuration and try again.');
  return extractIssues(result.stdout);
}

async function getKnipVersion(directory) {
  for (const location of [directory, path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)))]) {
    try {
      const pkg = JSON.parse(await readFile(path.join(location, 'node_modules/knip/package.json'), 'utf8'));
      return pkg.version;
    } catch {}
  }
  return null;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return printHelp();
  const directory = path.resolve(options.directory);
  const { packageJson } = await readProject(directory);
  const manager = await detectPackageManager(directory, packageJson);
  const knip = await findKnip(directory);
  knip.version = await getKnipVersion(directory);

  stdout.write(`Scanning ${path.relative(process.cwd(), directory) || '.'} with Knip…\n`);
  const report = await scanProject(directory, knip);
  const plan = collectPlan(report);
  if (options.json) {
    stdout.write(`${JSON.stringify({ knip: { version: knip.version, source: knip.source }, ...plan }, null, 2)}\n`);
    return;
  }
  displayPlan(plan, manager, knip);
  if (!options.apply || !plan.candidates.length) {
    if (plan.candidates.length) stdout.write('\nPreview only. Run with --apply to select candidates.\n');
    return;
  }

  const dirty = await getDirtyStatus(directory);
  if (dirty === true) stdout.write('\nWarning: the project worktree is dirty. Existing changes will not be discarded. Review the final diff carefully.\n');
  else if (dirty === null) stdout.write('\nWarning: git status is unavailable; worktree cleanliness could not be checked.\n');
  const checks = CHECK_SCRIPTS.filter((name) => typeof packageJson.scripts?.[name] === 'string');
  stdout.write(`Available validation scripts: ${checks.length ? checks.join(', ') : 'none'}\n`);

  let selected = await selectCandidates(plan, options.yes);
  if (!selected.length) { stdout.write('No automatically applicable items selected. Exports and types are shown for manual review and will not be auto-fixed.\n'); return; }

  // Re-scan immediately before changes. If Knip's result changed, interactive users must select again;
  // --yes aborts rather than silently applying a plan different from the one it approved.
  const currentPlan = collectPlan(await scanProject(directory, knip));
  if (planSummary(currentPlan) !== planSummary(plan)) {
    if (options.yes) throw new Error('Knip findings changed since the preview. Re-run pruneplan and review the updated plan.');
    displayPlan(currentPlan, manager, knip);
    selected = await selectCandidates(currentPlan, false);
    if (!selected.length) { stdout.write('No changes made.\n'); return; }
    const verifiedPlan = collectPlan(await scanProject(directory, knip));
    if (planSummary(verifiedPlan) !== planSummary(currentPlan)) throw new Error('Knip findings changed again. Re-run pruneplan before applying; no changes made.');
  } else if (!options.yes && (await promptLine('\nApply only the selected items? [y/N] ')).trim().toLowerCase() !== 'y') {
    stdout.write('No files changed.\n');
    return;
  }

  // Knip's fixer applies fixes globally, so export/type candidates are intentionally never passed to it.
  // File removals and package removals are scoped to explicit selection only.
  await removeSelectedFiles(directory, selected);
  const packages = [...new Set(selected.filter((item) => item.kind === 'dependency').map((item) => item.name))];
  if (packages.length) {
    stdout.write(`\nRemoving selected packages with ${manager}: ${packages.join(', ')}\n`);
    const result = run(manager, managerRemoveArgs(manager, packages), directory);
    if (result.status !== 0) throw new Error('Package manager removal failed. Review the current working tree before continuing.');
  }
  const checksPassed = await runChecks(directory, packageJson);
  stdout.write('\nSelected cleanup applied. Review the result with `git diff` before committing.\n');
  if (!checksPassed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`pruneplan: ${error.message}`);
  process.exitCode = 1;
});
