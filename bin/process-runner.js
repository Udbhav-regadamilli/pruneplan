import spawn from 'cross-spawn';

export function run(command, args, cwd, { capture = false } = {}) {
  const result = spawn.sync(command, args, {
    cwd, encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    shell: false,
    windowsHide: true,
  });
  if (result.error) throw new Error(`${command} could not be started: ${result.error.message}`);
  return result;
}

export function runWindowsShim(command, args, cwd, { capture = false } = {}) {
  return run(command, args, cwd, { capture });
}

export function runPackageManager(manager, args, cwd, options) {
  if (process.platform === 'win32') return runWindowsShim(`${manager}.cmd`, args, cwd, options);
  return run(manager, args, cwd, options);
}
