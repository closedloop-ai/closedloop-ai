#!/usr/bin/env node
/**
 * Runnable `crewd` entry point.
 *
 * The package ships TypeScript source (no build step: `exports` point at
 * `./src/*.ts`), so the CLI cannot be invoked by plain `node` — its `.js`
 * import specifiers resolve to on-disk `.ts` files. This thin `.mjs` wrapper
 * registers `tsx` at runtime and imports the TS CLI, then explicitly invokes
 * `main` with the real argv. The CLI module is side-effect-free (it does NOT
 * self-invoke `main` at import), so importing it in a test never runs a command
 * against the host process argv — this wrapper is the only place that does.
 */
import { tsImport } from "tsx/esm/api";

const cli = await tsImport("../src/cli.ts", import.meta.url);
// `main` is async (FEA-4069): a command that touches the native
// `claude-scheduled-tasks` route awaits its filesystem reconcile before it
// resolves, so awaiting here keeps the process alive until that work completes.
await cli.main(process.argv.slice(2));
