# pruneplan

**Find dead code and unused packages. Review the cleanup before applying it.**

`pruneplan` gives you one reviewable cleanup flow for unused dependencies, files, exports, and types. It uses [Knip](https://knip.dev/) to analyze the project, removes dependencies through the package manager already in use, and updates the lockfile as part of that removal.

## Quick start

From the root of a JavaScript or TypeScript project:

```sh
npx pruneplan
```

This only prints a plan. After reviewing it, apply the cleanup interactively:

```sh
npx pruneplan --apply
```

To scan a different project, pass its directory:

```sh
npx pruneplan ../my-app
```

## What happens when you apply

1. `pruneplan` asks Knip to scan the project and displays the cleanup candidates.
2. After you confirm, it removes unused dependencies with npm, pnpm, Yarn, or Bun, updating the package manager's lockfile.
3. It asks Knip to remove reported unused files, exports, and types.
4. It runs any `typecheck`, `lint`, `test`, and `build` scripts defined in the project's `package.json`.
5. It leaves the changes in your working tree for review with `git diff`.

For CI or other non-interactive use, `--yes` explicitly skips the prompt:

```sh
npx pruneplan --yes
```

## Safety

- The default command only reports findings. It does not modify files.
- Applying requires `--apply` plus an interactive confirmation, or the explicit `--yes` flag.
- Package removals use your detected package manager so its lockfile is updated too.
- npm and pnpm package removals skip install scripts.
- Validation runs only scripts that already exist in your project. These are ordinary project commands and may have their own side effects.
- Static analysis can miss runtime-loaded packages and exports used through reflection, plugins, or external consumers. Review the plan and final diff before committing.
- If validation fails, the changes remain in your working tree so you can inspect and fix them; `pruneplan` does not discard project changes.

## Requirements

- Node.js 20.19+, or 22.12+
- A JavaScript or TypeScript project with a `package.json`
- npm, pnpm, Yarn, or Bun, identified from a lockfile or the `packageManager` field

Knip is installed as a dependency of `pruneplan`; you do not need to add it to the project being scanned.

## License

MIT
