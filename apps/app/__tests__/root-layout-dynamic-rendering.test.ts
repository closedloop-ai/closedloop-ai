/**
 * ISS-8950 Property 1 — `apps/app` enforces its strict CSP in production, and
 * the whole nonce mechanism rests on this app never being STATICALLY
 * PRERENDERED. Prerendered HTML is frozen at build time, so it cannot carry the
 * per-request `nonce-…` the middleware stamps into `script-src`; every script
 * on such a document violates an enforcing policy, in the user's browser, with
 * nothing server-side to notice.
 *
 * Before this suite the property was held only as a SIDE EFFECT of the layout's
 * `await headers()` nonce read — no comment, no `export const dynamic`, no
 * test. That accident is precisely what already shipped on `apps/web`
 * (ISS-8949), whose root layout carries the identical read but whose 404 does
 * not route through it: it prerendered, edge-cached, and served 9 scripts with
 * 0 nonces against a policy still stamping a fresh nonce.
 *
 * Two independent halves are pinned, because either alone can fail:
 *  - the segment config, which states the invariant for every route beneath
 *    this layout and survives the nonce read being refactored away;
 *  - the `x-nonce` request-header read, which is the name Clerk emits the
 *    minted nonce under, and the only way the value reaches the tree.
 *
 * What this CANNOT show: that any given route is in fact not prerendered. Next
 * reads segment config statically, so the exported declaration IS the contract
 * and pinning it is the right unit here — but only a build's per-route
 * classification observes the result, and nothing pre-merge does that.
 *
 * Read from the AST, not text-scanned: `no-raw-text-source-scan` bans scanning
 * implementation source and points at `ts.createSourceFile`. It matters beyond
 * compliance here — the layout's own docstrings now name both `force-dynamic`
 * and `x-nonce` in prose, which is exactly what a text scan false-positives on.
 *
 * Both readers are pinned by synthetic fixtures in BOTH directions, so a reader
 * that regressed to always-found or always-missing cannot report this layout
 * compliant forever.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript6";
import { describe, expect, it } from "vitest";

const LAYOUT_PATH = path.join(process.cwd(), "app", "layout.tsx");
// Written out, never read back out of the module under test: a fixture that
// derives its expectation from the value it polices cannot fail.
const SEGMENT_CONFIG_NAME = "dynamic";
const FORCE_DYNAMIC = "force-dynamic";
const NONCE_HEADER = "x-nonce";

const layoutSource = readFileSync(LAYOUT_PATH, "utf8");

describe("root layout dynamic-rendering invariant (ISS-8950)", () => {
  it("declares force-dynamic, so no route beneath it can be prerendered", () => {
    expect(exportedStringConst(layoutSource, SEGMENT_CONFIG_NAME)).toBe(
      FORCE_DYNAMIC
    );
  });

  it("reads the nonce off the x-nonce request header", () => {
    expect(headerNamesRead(layoutSource)).toContain(NONCE_HEADER);
  });
});

describe("the segment-config reader itself", () => {
  it("returns the declared value rather than the expected one", () => {
    expect(
      exportedStringConst('export const dynamic = "auto";', "dynamic")
    ).toBe("auto");
  });

  it("ignores a same-named const that is not exported", () => {
    expect(
      exportedStringConst('const dynamic = "force-dynamic";', "dynamic")
    ).toBeUndefined();
  });

  it("returns undefined when the export is absent", () => {
    expect(exportedStringConst("export const other = 1;", "dynamic")).toBe(
      undefined
    );
  });
});

describe("the header reader itself", () => {
  it("finds a name read off an awaited headers() call", () => {
    expect(headerNamesRead('(await headers()).get("x-nonce");')).toContain(
      NONCE_HEADER
    );
  });

  it("does not report a name that only appears in prose or an assignment", () => {
    expect(headerNamesRead('// x-nonce\nconst v = "x-nonce";')).not.toContain(
      NONCE_HEADER
    );
  });

  // Without resolving the receiver, ANY `.get("x-nonce")` would satisfy the
  // suite — including one off a different request-scoped store, which would
  // never carry Clerk's header.
  it("does not report a name read off a different store", () => {
    expect(headerNamesRead('(await cookies()).get("x-nonce");')).not.toContain(
      NONCE_HEADER
    );
    expect(
      headerNamesRead('new URLSearchParams().get("x-nonce");')
    ).not.toContain(NONCE_HEADER);
  });
});

function parse(code: string): ts.SourceFile {
  return ts.createSourceFile(
    "layout.tsx",
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
}

/**
 * Value of `export const <name> = "<literal>"`, or `undefined` when the module
 * does not export that name as a string const. Next reads route segment config
 * statically, so the exported declaration IS the contract.
 */
function exportedStringConst(code: string, name: string): string | undefined {
  for (const statement of parse(code).statements) {
    if (!(ts.isVariableStatement(statement) && isExported(statement))) {
      continue;
    }
    const value = stringInitializerOf(statement.declarationList, name);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function isExported(statement: ts.VariableStatement): boolean {
  return (
    statement.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
    ) === true
  );
}

function stringInitializerOf(
  declarations: ts.VariableDeclarationList,
  name: string
): string | undefined {
  for (const declaration of declarations.declarations) {
    const initializer = declaration.initializer;
    if (
      ts.isIdentifier(declaration.name) &&
      declaration.name.text === name &&
      initializer &&
      ts.isStringLiteral(initializer)
    ) {
      return initializer.text;
    }
  }
  return undefined;
}

/**
 * Every header name the module reads off a `headers()` call, as
 * `(await headers()).get("…")`.
 *
 * Both halves are load-bearing. Resolving the CALL rather than the bare string
 * literal rules out the name sitting in a comment or an unrelated assignment;
 * resolving the RECEIVER rules out a `.get("x-nonce")` on some other
 * request-scoped store, which would satisfy a looser reader while carrying
 * nothing Clerk emitted.
 */
function headerNamesRead(code: string): string[] {
  const source = parse(code);
  const names: string[] = [];
  const visit = (node: ts.Node) => {
    const name = headerNameReadBy(node);
    if (name !== undefined) {
      names.push(name);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return names;
}

/** The literal header name this node reads, when it is a `headers().get("…")`. */
function headerNameReadBy(node: ts.Node): string | undefined {
  if (!(ts.isCallExpression(node) && node.arguments.length === 1)) {
    return undefined;
  }
  const callee = node.expression;
  const argument = node.arguments[0];
  if (
    !(
      ts.isPropertyAccessExpression(callee) &&
      callee.name.text === "get" &&
      argument &&
      ts.isStringLiteral(argument) &&
      readsFromHeaders(callee.expression)
    )
  ) {
    return undefined;
  }
  return argument.text;
}

/** Whether an expression is the `headers()` call itself, through `await`/parens. */
function readsFromHeaders(expression: ts.Expression): boolean {
  let current: ts.Node = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAwaitExpression(current)
  ) {
    current = current.expression;
  }
  return (
    ts.isCallExpression(current) &&
    ts.isIdentifier(current.expression) &&
    current.expression.text === "headers"
  );
}
