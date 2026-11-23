# pruneplan

**Find dead code and unused packages. Review the cleanup before applying it.**

`pruneplan` gives you a reviewable cleanup flow for unused dependencies, files, exports, and types. It uses [Knip](https://knip.dev/) to analyze a JavaScript or TypeScript project, and leaves changes in your working tree for review.

## Quick start

From the root of a JavaScript or TypeScript project:

```sh
npx pruneplan
```

This only prints a plan. Apply selected candidates interactively:

```sh
npx pruneplan --apply
```

Choose candidate numbers separated by commas, or `all`. Configuration-like files are highlighted and require explicit selection. To scan another project, pass its directory:

```sh
npx pruneplan ../my-app
```

For CI or other non-interactive use, `--yes` applies all safely actionable findings without prompting. It excludes configuration-like files and aborts if the Knip findings changed since preview:

```sh
npx pruneplan --yes
```

Use `--json` to print a machine-readable report, including warnings and Knip version/source:

```sh
npx pruneplan --json
```

## Review and safety

- The default command is preview-only and does not modify files.
- Interactive apply is item-selective; only selected files are removed and only selected dependencies are passed to your package manager.
- Knip's auto-fixer operates across findings rather than an individual selected export. To ensure pruneplan never changes unselected exports or types, those candidates are displayed for manual review but are not automatically fixed.
- Unlisted dependencies, duplicate exports, and other Knip issue categories are surfaced as warnings and are never interpreted as install suggestions or automatic cleanup.
- Configuration-like files are marked for extra review. Use Knip configuration (entries, workspaces, project patterns, or ignore settings) to correct analysis scope instead of assuming a flagged config file is dead.
- Immediately before applying, pruneplan scans again. If findings changed, interactive users review/select against the updated plan; `--yes` aborts rather than applying a stale plan.
- A dirty Git worktree is reported before changes. Existing changes are never automatically discarded.
- Available `typecheck`, `lint`, `test`, and `build` scripts are listed before apply and run afterwards. Passing checks does not guarantee every runtime path is covered.
- If validation fails, changes remain in the working tree. Review with `git diff` and recover manually as needed.
- Static analysis can miss runtime-loaded dependencies and exports used through reflection, plugins, dynamic routes, or external consumers. Findings are candidates, not proof they are safe to remove.

## Requirements

- Node.js 20.19+, or 22.12+
- A JavaScript or TypeScript project with a `package.json`
- npm, pnpm, Yarn, or Bun, identified from a lockfile or the `packageManager` field

Knip is bundled with pruneplan; a project-local Knip installation is preferred when present.

## License

MIT
