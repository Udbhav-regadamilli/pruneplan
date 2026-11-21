# Contributing

Thanks for considering a contribution to pruneplan.

## Before opening a pull request

- Keep cleanup preview-only unless the user explicitly applies a plan.
- Preserve the target project's selected package manager and lockfile.
- Explain safety trade-offs in user-facing messages and documentation.
- Run `node --check bin/pruneplan.js` and `npm pack --dry-run` before submitting.

Please include a clear reproduction for bug reports and describe the package manager and Node.js version involved.
