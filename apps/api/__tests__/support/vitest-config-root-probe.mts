import compatibilityConfig from "../../vitest.config.compatibility.mts";
import integrationConfig from "../../vitest.config.integration.mts";
import unitConfig from "../../vitest.config.mts";

/**
 * Prints the `root` a named apps/api vitest config resolves to, from whatever
 * cwd this process was launched in (ISS-8174).
 *
 * A SUBPROCESS is the whole point. The assertion is that these configs anchor
 * `root` to their own directory rather than inheriting `process.cwd()`, and
 * in-process that distinction is invisible: the suite already runs with cwd set
 * to apps/api, so both spellings produce the same answer. Launching from
 * somewhere else is the only way to tell them apart, and `process.chdir()` is
 * not an option — it is process-wide, so it would move the cwd out from under
 * every sibling test sharing the worker.
 *
 * The three configs are imported STATICALLY and looked up by name rather than
 * imported from `process.argv`. A parameterized `import()` is a specifier the
 * `no-desktop-gateway-import` source gate cannot fold, and an unfoldable
 * specifier in apps/api is a violation by construction — it cannot be proven
 * not to reach the privileged desktop tree.
 *
 * Usage: `tsx vitest-config-root-probe.mts <config-file-name>`
 */
const CONFIGS_BY_NAME = {
  "vitest.config.mts": unitConfig,
  "vitest.config.integration.mts": integrationConfig,
  "vitest.config.compatibility.mts": compatibilityConfig,
} as Record<string, { root?: string } | undefined>;

const requested = process.argv[2];
const config = requested ? CONFIGS_BY_NAME[requested] : undefined;
if (!config) {
  process.stderr.write(
    `unknown config ${JSON.stringify(requested)} — expected one of ${Object.keys(CONFIGS_BY_NAME).join(", ")}\n`
  );
  process.exit(2);
}

process.stdout.write(String(config.root ?? "<no root>"));
