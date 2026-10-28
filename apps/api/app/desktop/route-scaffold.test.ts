import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript6";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * ISS-8618 (PRD-699 §7.5). The desktop write-lane routes share one scaffold in
 * `route-helpers.ts`: the `computeTargetId` gate and the capped/gzip body read.
 * Every one of them once carried its own copy, and the copies drifted — the
 * invocations route was still answering a 400 where the shared reader answers
 * 500 (ISS-8688) months after that fix landed everywhere else.
 *
 * An extraction rots by being quietly bypassed, not by being deleted, so this
 * guard watches for the bypass: a route re-inlining the body scaffold needs
 * `readCappedRequestText` (or its truncation/over-cap siblings) from
 * `@/lib/route-utils`, and reaching for one of those here fails.
 *
 * TWO things it does NOT pin, and neither is a gap to fill defensively:
 *
 * - That the helpers BEHAVE correctly. Each route's own `route.test.ts` owns
 *   the 400/413/500 branches; this pins only that they run through one body of
 *   code.
 * - That a route performs an ownership check AT ALL. `requireComputeTargetId`
 *   is a shape gate, not an authorization one — ownership is the service's, and
 *   `apps/api/AGENTS.md` is where that duty is stated. What is pinned here is
 *   narrower and mechanical: a write-lane route may not hand-roll the gate the
 *   others share. A route naming `computeTargetId` while on `route-helpers` and
 *   absent from the table below reds the first case.
 *
 * The re-inline check is by IMPORT NAME, so a route that reimplements bounded
 * reading from `request.body.getReader()` under a fresh name is invisible to
 * it. That is the shape review owns; this catches the copy-paste one, which is
 * the shape that actually happened (ISS-8688).
 */

/** The body reader each route is expected to be on. */
const BodyReader = {
  Gzip: "readBoundedMaybeGzipJsonBody",
  Plain: "readBoundedJsonBody",
} as const;
type BodyReader = (typeof BodyReader)[keyof typeof BodyReader];

type ScaffoldExpectation = {
  bodyReader: BodyReader;
  /**
   * `false` only for the invocations lane, whose exact per-part ack has no
   * `details.reason` channel for the helper's coded non-UUID 400 — see the
   * comment at its `computeTargetId` gate.
   */
  sharedComputeTargetIdGate: boolean;
};

const EXPECTED_SCAFFOLD: Record<string, ScaffoldExpectation> = {
  "agent-sessions/invocations/sync/route.ts": {
    bodyReader: BodyReader.Plain,
    sharedComputeTargetIdGate: false,
  },
  "agent-sessions/sync/route.ts": {
    bodyReader: BodyReader.Gzip,
    sharedComputeTargetIdGate: true,
  },
  "analytics/route.ts": {
    bodyReader: BodyReader.Plain,
    sharedComputeTargetIdGate: true,
  },
  "claude-code-telemetry/sync/route.ts": {
    bodyReader: BodyReader.Plain,
    sharedComputeTargetIdGate: true,
  },
  "components/sync/route.ts": {
    bodyReader: BodyReader.Plain,
    sharedComputeTargetIdGate: true,
  },
  "telemetry/route.ts": {
    bodyReader: BodyReader.Plain,
    sharedComputeTargetIdGate: true,
  },
};

/**
 * Re-inlining the body scaffold means reaching for these. A route on
 * `route-helpers` needs none of them.
 */
const INLINE_BODY_SCAFFOLD_IMPORTS = [
  "logRequestBodyOverCap",
  "readCappedRequestText",
  "requestBodyTruncationError",
] as const;

describe("desktop write-lane routes stay on the shared scaffold", () => {
  it("covers every write-lane route, gate-sharing or not", () => {
    const writeLane = collectWriteLaneRouteModules();

    expect(writeLane.length).toBeGreaterThan(0);
    for (const module of writeLane) {
      expect(
        EXPECTED_SCAFFOLD[module],
        `${module} is a compute-target route on route-helpers but this guard does not describe it`
      ).toBeDefined();
    }
    expect(writeLane).toEqual(Object.keys(EXPECTED_SCAFFOLD).sort());
  });

  it("imports each route's scaffold from route-helpers", () => {
    for (const [module, expected] of Object.entries(EXPECTED_SCAFFOLD)) {
      const imports = collectImports(join(HERE, module));
      const fromHelpers = imports
        .filter((entry) => entry.specifier.endsWith("route-helpers"))
        .flatMap((entry) => entry.names);

      expect(
        fromHelpers,
        `${module} no longer reads its body through the shared scaffold`
      ).toContain(expected.bodyReader);
      expect(
        fromHelpers.includes("requireComputeTargetId"),
        `${module} compute-target gate disagrees with this guard`
      ).toBe(expected.sharedComputeTargetIdGate);
    }
  });

  it("keeps the body scaffold out of every desktop route", () => {
    const modules = collectRouteModules(HERE);

    expect(modules.length).toBeGreaterThan(
      Object.keys(EXPECTED_SCAFFOLD).length
    );
    for (const module of modules) {
      const imported = new Set(
        collectImports(join(HERE, module)).flatMap((entry) => entry.names)
      );
      for (const name of INLINE_BODY_SCAFFOLD_IMPORTS) {
        expect(
          imported.has(name),
          `${module} imports ${name}; the body scaffold has been re-inlined instead of shared`
        ).toBe(false);
      }
    }
  });
});

/**
 * A desktop route is on the write lane when it reads its body through
 * `route-helpers` AND takes a compute target — either through the shared gate
 * or by naming the param itself. The second half is what makes a NEW route
 * appear here whether or not it adopted the gate, rather than only the routes
 * that already did; the handshake routes share the body reader and take no
 * compute target, so they stay out.
 */
function collectWriteLaneRouteModules(): string[] {
  return collectRouteModules(HERE).filter((module) => {
    const file = join(HERE, module);
    const imports = collectImports(file);
    if (!imports.some((entry) => entry.specifier.endsWith("route-helpers"))) {
      return false;
    }
    return (
      imports
        .flatMap((entry) => entry.names)
        .includes("requireComputeTargetId") || namesComputeTargetId(file)
    );
  });
}

function namesComputeTargetId(file: string): boolean {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true
  );

  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) {
      return;
    }
    if (ts.isStringLiteral(node) && node.text === "computeTargetId") {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function collectRouteModules(directory: string): string[] {
  const modules: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      modules.push(...collectRouteModules(absolute));
      continue;
    }
    if (entry.name === "route.ts") {
      modules.push(relative(HERE, absolute).split(sep).join("/"));
    }
  }
  return modules.sort();
}

function collectImports(
  file: string
): { specifier: string; names: string[] }[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true
  );

  const imports: { specifier: string; names: string[] }[] = [];
  for (const statement of source.statements) {
    if (
      !(
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier)
      )
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    const names =
      bindings && ts.isNamedImports(bindings)
        ? bindings.elements.map((element) => element.name.text)
        : [];
    imports.push({ specifier: statement.moduleSpecifier.text, names });
  }
  return imports;
}
