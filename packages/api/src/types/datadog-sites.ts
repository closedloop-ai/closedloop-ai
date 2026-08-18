/**
 * The ONE allowlist of Datadog intake hosts any sender in this repo may attach
 * `DD-API-KEY` to (ISS-5417).
 *
 * ## Why it is a security control, not a convenience list
 *
 * Every sender interpolates `DD_SITE` into the request AUTHORITY while the key
 * rides along as a header — `https://api.${site}/…`,
 * `https://http-intake.logs.${site}/…`. So a `DD_SITE` carrying a userinfo
 * suffix (`datadoghq.com@attacker.example`) resolves the authority to the
 * attacker and posts the key there. Exact membership on the WHOLE value is the
 * defense, and every sender has to apply the SAME list: an allowlist that
 * covers one sender and not another is not a control, it just moves which
 * request leaks the key.
 *
 * ## Why it lives here
 *
 * It had drifted into three verbatim copies with three different owners —
 * `packages/observability` (the metrics submitter + the agentless log sink),
 * `packages/database/scripts/migrate-telemetry.ts` (build-time migrate
 * telemetry), and `scripts/ci/gha-cost-telemetry.ts` (the daily GHA cost
 * publisher). No two of them share a package, and the two obvious homes are
 * both closed: `packages/database` must not import `@repo/observability` (it is
 * packaged into the `apps/mcp` image through a narrow Docker context — see
 * `packages/database/AGENTS.md`), and a CI script must not import a DB module.
 *
 * `packages/api/src/types/` is the repo's canonical home for a value set that
 * multiple packages consume, and it is the one module all three consumers can
 * already reach: `@repo/api` is a declared dependency of both `@repo/database`
 * and `@repo/observability`, and `scripts/` already imports `@repo/api/src/types/*`
 * by subpath (`desktop-release`, `db-health`).
 *
 * Deliberately ZERO imports. `@repo/observability/log` is reachable from client
 * components, so this module must stay free of Zod and any other heavy
 * validation dependency (root `AGENTS.md` → keep shared constants in
 * lightweight modules).
 *
 * A fourth copy is blocked mechanically by the `no-duplicate-datadog-site-allowlist`
 * source gate (`scripts/lint/rules/`), which fails on any collection literal
 * naming two or more of these hosts outside this module.
 */

/**
 * Datadog's public intake sites, keyed by Datadog's own site names.
 *
 * This object is the single list — {@link DEFAULT_DD_SITE} and
 * {@link isAllowedDatadogSite} are both derived from it, so a site added or
 * removed here cannot fall out of step with the membership test.
 */
export const DatadogSite = {
  Us1: "datadoghq.com",
  Us3: "us3.datadoghq.com",
  Us5: "us5.datadoghq.com",
  Eu1: "datadoghq.eu",
  Ap1: "ap1.datadoghq.com",
  Us1Fed: "ddog-gov.com",
} as const;

export type DatadogSite = (typeof DatadogSite)[keyof typeof DatadogSite];

/**
 * The site every sender falls back to when `DD_SITE` is unset or empty, matching
 * Datadog's own default. Callers should read `env.DD_SITE || DEFAULT_DD_SITE`:
 * an EMPTY `DD_SITE` must fall back rather than fail the membership test, which
 * `??` would not do.
 */
export const DEFAULT_DD_SITE: DatadogSite = DatadogSite.Us1;

const ALLOWED_DD_SITES: ReadonlySet<string> = new Set<string>(
  Object.values(DatadogSite)
);

/**
 * Exact membership on the WHOLE value, deliberately — not a prefix, suffix, or
 * substring test. `datadoghq.com@attacker.example`, `datadoghq.com.evil.test`,
 * `datadoghq.com:8443`, and a trailing dot all fail here, which is the point.
 */
export function isAllowedDatadogSite(site: string): site is DatadogSite {
  return ALLOWED_DD_SITES.has(site);
}
