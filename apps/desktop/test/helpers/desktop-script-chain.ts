/**
 * The desktop package scripts a lane's entry script chains through, and the
 * `NODE_TEST_RUNNER_TIMEOUT_MS` values they declare.
 *
 * ISS-6410 review (wongk): `run-node-tests.mjs` honors that override, so the
 * cap a lane's job budget has to clear is not necessarily
 * `DEFAULT_RUNNER_TIMEOUT_MS`. This is not theoretical — `test:node:coverage`
 * already raises it to 2400000 in the very same manifest. It sits outside the
 * guarded lanes' chain today, and following the chain is what keeps a lane's
 * budget honest if that stops being true.
 */
import fs from "node:fs";
import path from "node:path";

export const RUNNER_TIMEOUT_OVERRIDE = "NODE_TEST_RUNNER_TIMEOUT_MS";

/** `pnpm <script>` / `pnpm run <script>` references inside a script body. */
const SCRIPT_REFERENCE = /\bpnpm(?:\s+run)?\s+([A-Za-z0-9:_-]+)/g;

/** An inline `NODE_TEST_RUNNER_TIMEOUT_MS=…` assignment on a script's command. */
const OVERRIDE_ASSIGNMENT = new RegExp(`\\b${RUNNER_TIMEOUT_OVERRIDE}=(\\S+)`);

// cwd for the desktop test suite is apps/desktop.
function desktopScripts(): Record<string, string> {
  const manifest = JSON.parse(
    fs.readFileSync(path.resolve("package.json"), "utf8")
  ) as { scripts?: Record<string, string> };
  return manifest.scripts ?? {};
}

/**
 * Every `NODE_TEST_RUNNER_TIMEOUT_MS` declared by `entryScript` or by a script
 * it chains through, as written.
 *
 * Throws on an unknown entry rather than returning an empty list: a renamed
 * script must fail the guard, not quietly make it scan nothing.
 */
export function scriptChainOverrides(entryScript: string): string[] {
  const scripts = desktopScripts();
  if (scripts[entryScript] === undefined) {
    throw new Error(
      `apps/desktop/package.json has no \`${entryScript}\` script, so this guard cannot follow the chain a lane runs`
    );
  }

  const overrides: string[] = [];
  const seen = new Set<string>();
  const queue = [entryScript];
  while (queue.length > 0) {
    const name = queue.shift();
    if (name === undefined || seen.has(name)) {
      continue;
    }
    seen.add(name);
    const body = scripts[name];
    if (body === undefined) {
      continue;
    }
    const declared = OVERRIDE_ASSIGNMENT.exec(body)?.[1];
    if (declared !== undefined) {
      overrides.push(declared);
    }
    for (const reference of body.matchAll(SCRIPT_REFERENCE)) {
      queue.push(reference[1]);
    }
  }
  return overrides;
}
