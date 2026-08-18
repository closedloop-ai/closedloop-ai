# apps/desktop/test — main-process suites (Vitest + a node:test remainder) + Electron E2E

`test:node` (fast slice, also `dagger call test-desktop-node`) and `test/e2e/` (the required `desktop-e2e` check). Node 25 breaks `depcruise` and kills `test:node` before any test runs — `nvm use` the `.nvmrc` pin.

## Grandfathered files are shrink-only, including tests

The largest offenders here are test files, because "add another scenario cluster to the existing suite" is the natural move.

- **Never grow a file in the `biome.jsonc` grandfather list.** New scenarios go in a focused sibling suite so the grandfathered file finishes **no larger than its merge base**. Shared setup moves to a shared fixture module.
- Enforced by `pnpm check:grandfather-line-growth` (a separate CI `lint` step, not `pnpm lint`) against the **merge base**, so run it explicitly before pushing — `pnpm -w run lint` passing is not evidence you complied.
- Bringing a file back under 1,000 lines means deleting its `biome.jsonc` entry in the same PR (verify with `npx biome lint <file>`). Never add an entry.

## Coverage must reach the real boundary

- **A UI bug fix needs an Electron E2E through the launched app.** Component tests inject both ends independently, so a green renderer suite does not prove the chain `collector/manager → runtime-status IPC → preload → component` survives. Add the regression to the existing harness spec rather than a new one where possible.
- A pure-mapper test passing does not prove the value reaches the user — assert the visible cell in the launched-app spec when the mapped field is user-facing.
- Assert the mapping under test, not just the count/class around it: a marker component could render every state identically and a suite that only checks counts stays green.
- Use the **full IPC response shape** in renderer test fixtures. Asserting a bare success value that is outside the real contract (e.g. `{ ok: true, enabled: false }` reduced to `true`) means the renderer is tested against a response the main process never sends. Cover both the mismatched-success and the `{ ok: false, error }` path.

## Import hazard (kills the whole suite)

Importing a main-process module into an E2E spec aborts the **entire** suite at load time — `@repo/*` TS subpaths resolve without extensions in the app but not under the spec loader. A red `desktop-e2e` with no `✘` line is a load abort: grep the log for `Cannot find module`.

## Moved code

Moving a function out of a module leaves importers pointing at the old path. `node:test` will not surface it as a rename — grep every test for the old subpath in the same change.
