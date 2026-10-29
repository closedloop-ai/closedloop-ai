/**
 * ISS-9244 — the root layout takes its `bootstrapFeatureFlags` decision from
 * `bootstrapsFeatureFlags`, and hands it the two LIVE env reads.
 *
 * `lib/analytics/__tests__/feature-flag-bootstrap.test.ts` proves the predicate.
 * It cannot prove the app CONSUMES it: nothing there loads the root layout, so
 * restoring the literal `bootstrapFeatureFlags` at the one mount site leaves all
 * of it green while the deployed lane silently goes back to booting the
 * signed-in persona's real assignment into the RSC payload — which is the
 * failure this ticket exists to end, and which reports as an unrelated
 * assertion about page size rather than as a flag.
 *
 * The ARGUMENTS are pinned, not just the callee. All three are `env` property
 * reads, and any one replaced by a literal typechecks and keeps a callee-only
 * assertion green: `bootstrapsFeatureFlags(env.E2E_…, "stage", env.NEXT_PUBLIC_APP_URL)`
 * would defeat the declaration refusal on every deployment forever, and a
 * literal third argument would defeat the canonical-production-host refusal on
 * the one deployment it exists for. So the detector renders the whole call and
 * the test compares that string.
 *
 * Read from the AST, not text-scanned: `no-raw-text-source-scan` bans scanning
 * implementation source and points at `ts.createSourceFile`. It matters beyond
 * compliance for the root layout, whose docstrings name components in prose —
 * exactly what a text scan false-positives on.
 *
 * The detector is pinned by synthetic fixtures in both directions, matching the
 * sibling RUM suite: one that regressed to always returning the expected string
 * would report this layout wired forever.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript6";
import { describe, expect, it } from "vitest";
import { localNamesFor } from "./support/renders-imported-component";

const LAYOUT_PATH = path.join(process.cwd(), "app", "layout.tsx");
const PROVIDER_MODULE = "@repo/analytics/provider";
const PROVIDER_EXPORT = "AnalyticsProvider";
const PREDICATE_MODULE = "@/lib/analytics/feature-flag-bootstrap";
const PREDICATE_EXPORT = "bootstrapsFeatureFlags";
const ENV_MODULE = "@/env";
const ENV_EXPORT = "env";
const BOOTSTRAP_ATTRIBUTE = "bootstrapFeatureFlags";
const NO_ATTRIBUTE = "<no bootstrapFeatureFlags attribute>";
const HARDCODED = "<hardcoded bootstrapFeatureFlags>";
const NOT_A_CALL = "<bootstrapFeatureFlags is not a call>";
const WIRED_ARGS =
  "env.E2E_SUPPRESS_FEATURE_FLAG_BOOTSTRAP, env.NEXT_PUBLIC_APP_ENVIRONMENT, env.NEXT_PUBLIC_APP_URL";
const WIRED_CALL = `${PREDICATE_EXPORT}(${WIRED_ARGS})`;

const layoutSource = readFileSync(LAYOUT_PATH, "utf8");

describe("root layout feature-flag bootstrap wiring", () => {
  it("calls the predicate with the suppression signal and the declared environment", () => {
    expect(bootstrapCallDescriptor(layoutSource)).toBe(WIRED_CALL);
  });
});

describe("the wiring detector itself", () => {
  const imports = `import { ${ENV_EXPORT} } from "${ENV_MODULE}";\nimport { ${PREDICATE_EXPORT} } from "${PREDICATE_MODULE}";\nimport { ${PROVIDER_EXPORT} } from "${PROVIDER_MODULE}";`;
  const wrap = (attribute: string) =>
    `${imports}\nexport const L = () => <${PROVIDER_EXPORT} ${attribute} />;`;

  it("renders the wired call", () => {
    const code = wrap(
      `${BOOTSTRAP_ATTRIBUTE}={${PREDICATE_EXPORT}(${WIRED_ARGS})}`
    );
    expect(bootstrapCallDescriptor(code)).toBe(WIRED_CALL);
  });

  it("reports a hardcoded shorthand attribute", () => {
    expect(bootstrapCallDescriptor(wrap(BOOTSTRAP_ATTRIBUTE))).toBe(HARDCODED);
  });

  it("reports a literal argument rather than the env read it replaced", () => {
    const declaration = wrap(
      `${BOOTSTRAP_ATTRIBUTE}={${PREDICATE_EXPORT}(env.E2E_SUPPRESS_FEATURE_FLAG_BOOTSTRAP, "stage", env.NEXT_PUBLIC_APP_URL)}`
    );
    expect(bootstrapCallDescriptor(declaration)).not.toBe(WIRED_CALL);
    expect(bootstrapCallDescriptor(declaration)).toContain('"stage"');

    // The host argument is the independent production refusal (whitlockk, #6683);
    // a literal there would defeat it on the one deployment it exists for.
    const host = wrap(
      `${BOOTSTRAP_ATTRIBUTE}={${PREDICATE_EXPORT}(env.E2E_SUPPRESS_FEATURE_FLAG_BOOTSTRAP, env.NEXT_PUBLIC_APP_ENVIRONMENT, "https://app.stage.example")}`
    );
    expect(bootstrapCallDescriptor(host)).not.toBe(WIRED_CALL);
    expect(bootstrapCallDescriptor(host)).toContain("stage.example");
  });

  it("reports a callee that is not the imported predicate", () => {
    const code = wrap(`${BOOTSTRAP_ATTRIBUTE}={somethingElse(${WIRED_ARGS})}`);
    expect(bootstrapCallDescriptor(code)).not.toBe(WIRED_CALL);
  });

  it("resolves an aliased import of the predicate rather than the literal name", () => {
    const aliased = `import { ${ENV_EXPORT} } from "${ENV_MODULE}";\nimport { ${PREDICATE_EXPORT} as Renamed } from "${PREDICATE_MODULE}";\nimport { ${PROVIDER_EXPORT} } from "${PROVIDER_MODULE}";\nexport const L = () => <${PROVIDER_EXPORT} ${BOOTSTRAP_ATTRIBUTE}={Renamed(${WIRED_ARGS})} />;`;
    expect(bootstrapCallDescriptor(aliased)).toBe(WIRED_CALL);
  });

  it("reports an absent attribute", () => {
    expect(bootstrapCallDescriptor(wrap("nonce={n}"))).toBe(NO_ATTRIBUTE);
  });
});

/**
 * The provider's `bootstrapFeatureFlags` value rendered as
 * `<predicate>(<arg>, <arg>)`, resolving the callee and the `env` binding
 * through their IMPORTS so an alias cannot hide either — or a marker naming what
 * was found instead, so a regression fails with a readable reason.
 */
function bootstrapCallDescriptor(code: string): string {
  const source = ts.createSourceFile(
    "layout.tsx",
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const attribute = findBootstrapAttribute(
    source,
    localNamesFor(source, PROVIDER_MODULE, PROVIDER_EXPORT)
  );
  if (!attribute) {
    return NO_ATTRIBUTE;
  }
  const initializer = attribute.initializer;
  if (!(initializer && ts.isJsxExpression(initializer))) {
    return HARDCODED;
  }
  const call = initializer.expression;
  if (
    !(call && ts.isCallExpression(call) && ts.isIdentifier(call.expression))
  ) {
    return NOT_A_CALL;
  }
  const predicateNames = localNamesFor(
    source,
    PREDICATE_MODULE,
    PREDICATE_EXPORT
  );
  const callee = predicateNames.has(call.expression.text)
    ? PREDICATE_EXPORT
    : call.expression.text;
  const envNames = localNamesFor(source, ENV_MODULE, ENV_EXPORT);
  const args = call.arguments
    .map((argument) => renderArgument(argument, source, envNames))
    .join(", ");
  return `${callee}(${args})`;
}

/** `env.KEY` when the argument reads the imported env object, else its source text. */
function renderArgument(
  argument: ts.Expression,
  source: ts.SourceFile,
  envNames: ReadonlySet<string>
): string {
  if (
    ts.isPropertyAccessExpression(argument) &&
    ts.isIdentifier(argument.expression) &&
    envNames.has(argument.expression.text)
  ) {
    return `${ENV_EXPORT}.${argument.name.text}`;
  }
  return argument.getText(source);
}

function findBootstrapAttribute(
  source: ts.SourceFile,
  providerNames: ReadonlySet<string>
): ts.JsxAttribute | undefined {
  let found: ts.JsxAttribute | undefined;
  const visit = (node: ts.Node) => {
    if (
      (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) &&
      providerNames.has(node.tagName.getText(source))
    ) {
      for (const property of node.attributes.properties) {
        if (
          ts.isJsxAttribute(property) &&
          property.name.getText(source) === BOOTSTRAP_ATTRIBUTE
        ) {
          found ??= property;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return found;
}
