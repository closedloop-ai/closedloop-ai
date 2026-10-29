import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import ts from "typescript6";
import { describe, expect, it } from "vitest";

/**
 * ISS-8521 — the shrink-only ledger of reads still resolving a branch's PR
 * through the retired pointer (`BranchDetail.currentPullRequestDetailId` /
 * `PullRequestDetail.isCurrent`) instead of the owned-set derivation.
 *
 * The migration's whole risk is a read nobody knew about: two prior sweeps
 * under-counted this inventory by ~2.5x because they grepped, and a grep over
 * `isCurrent` cannot tell a PR pointer from an agent-component version flag or
 * a desktop `isCurrent()` cancellation callback. So this walks the AST and pins
 * the surviving set exactly. Adding a pointer read to a file not listed here
 * fails; migrating one off the pointer fails until its entry shrinks or goes.
 * That is the proof AC2 asks for — a sweep that runs, not an inspection of the
 * handful of files a ticket happened to name.
 *
 * EVERY direct read counts, including one inside a module that imports the
 * canonical chokepoint. An earlier revision exempted whole files that imported
 * `branch-canonical-pull-request`, on the theory that such a module had
 * migrated — but the import is often of an unrelated predicate
 * (`branchOwnsPullRequestDetail`), and the module goes on reading the raw
 * pointer beside it. That exemption hid 5 files and 7 reads, understating the
 * very number this ledger exists to state. A module that legitimately feeds the
 * pointer INTO the resolver still reads it, and is pinned here honestly; those
 * entries retire last, with the column itself (ISS-8523).
 *
 * A read written in SQL counts the same as one written in JavaScript. `where:
 * { isCurrent: true }` resolves the pointer exactly as `detail.isCurrent` does,
 * and `data: { currentPullRequestDetailId }` writes it; a detector that saw only
 * property access missed all of them and left `github-projection-writer.ts` and
 * `repo-reconciler.ts` off the ledger entirely while `pr-read-repair.ts` (since
 * deleted by ISS-11588) read 1 of its 3. A Prisma `select` / `include` key is the one object-literal shape
 * that does NOT count — it hydrates the column without deciding anything — and
 * it is syntactically identical to the `where` key, so the enclosing clause is
 * the only thing separating them.
 *
 * Only `branch-canonical-pull-request.ts` / `-cloud.ts` are exempt, as the
 * definition site of the arbitration rather than consumers of it. Since #6453
 * that arbitration is eligibility-first, so routing a read through it PRESERVES
 * the webhook-wins provenance a raw pointer read cannot see — retiring the
 * pointer means moving these 29 files onto that module, NOT deleting its arm.
 *
 * So read a drop here as WHERE the pointer is spelled, not as how much of the
 * column is retired. A file leaves this map when its read moves into the owning
 * module; the pointer stays exactly as load-bearing as it was, and ISS-8523's
 * work is unchanged by the move. The number measures the one thing AC2 asks
 * for — that no consumer resolves the pointer directly — and nothing else.
 *
 * Counts are per file, not per line, so the ledger measures migration progress
 * rather than formatting.
 */

/** Property names that name the pointer. Bare `isCurrent` is a PR flag here: the scan is scoped to `apps/api`, which has no other `isCurrent`. */
const POINTER_PROPERTY_NAMES = new Set([
  "currentPullRequestDetail",
  "currentPullRequestDetailId",
  "isCurrent",
]);

/** Prisma clauses that only carry the column. Every other clause decides with it. */
const HYDRATE_CLAUSE_NAMES = new Set(["select", "include"]);

/**
 * A hoisted select has no enclosing clause to read, so the literal is marked a
 * hydrate two other ways: a `satisfies Prisma.<Model>Select` annotation, or the
 * name of the const it initialises (`branchDetailSelect`). Both spellings are in
 * use here, and neither is optional — without them a hoisted select scores as a
 * pointer read and the ledger over-counts, which is the same lie as under-
 * counting pointed the other way.
 */
const HYDRATE_SHAPE_SUFFIXES = ["Select", "Include"];

/** The chokepoint itself — definition site of the arbitration, never a consumer. */
const OWNING_MODULES = new Set([
  "apps/api/app/branches/branch-canonical-pull-request.ts",
  "apps/api/app/branches/branch-canonical-pull-request-cloud.ts",
]);

// Anchored on this file, not `process.cwd()`: `apps/api` is a repo-root-sandbox
// mutation package, so under Stryker the cwd is the repo root and a cwd-relative
// walk would silently scan nothing (`__tests__/vitest-config-root-anchor.test.ts`).
const SCAN_TIMEOUT_MS = 60_000;

const API_ROOT = join(import.meta.dirname, "..");
const REPO_ROOT = join(API_ROOT, "..", "..");

/**
 * Files that still read the pointer directly, with how many reads each carries.
 * SHRINK-ONLY: an entry goes down or disappears as ISS-8704 / ISS-8705 /
 * ISS-8706 route it through the chokepoint. Never add one — a new consumer
 * resolves through `resolveBranchCanonicalPullRequestId` instead.
 *
 * What that rule is worth MECHANICALLY, stated so nobody reads more into the
 * green than it carries: this map ships in the same diff as the code it gates,
 * so one change CAN add a reader and raise its entry together and stay green.
 * The exact per-file pin is what makes that visible — the number moves in the
 * diff, right under this comment — but visible-in-review is not impossible, and
 * only a base-ref comparison is. ISS-9125 carries that ratchet, reusing the
 * `findRatchetViolations` shape in `scripts/lint/source-gate-allowlist.ts`.
 * Until it lands, a raised number here is the reviewer's catch, not the gate's.
 */
const UNMIGRATED_POINTER_READS: Readonly<Record<string, number>> = {
  "apps/api/app/agent-sessions/service/artifact-links/pull-request-base-branch.ts": 2,
  "apps/api/app/agent-sessions/service/session-pr-status.ts": 2,
  "apps/api/app/artifact-links/link-projections.ts": 3,
  "apps/api/app/branches/branch-compatibility-resolver.ts": 1,
  "apps/api/app/branches/branch-provider-fallback-service.ts": 1,
  "apps/api/app/branches/branch-pull-request-authority-refresh.ts": 1,
  "apps/api/app/branches/branch-read-service/canonical-projection.ts": 2,
  "apps/api/app/branches/branch-refresh-support.ts": 1,
  "apps/api/app/branches/branch-remote-evidence.ts": 1,
  "apps/api/app/branches/branch-service.ts": 6,
  "apps/api/app/branches/github-projection-writer.ts": 6,
  "apps/api/app/branches/pull-request-branch-relink.ts": 4,
  "apps/api/app/branches/pull-request-current-promotion.ts": 6,
  "apps/api/app/branches/pull-request-provider-identity.ts": 2,
  // ISS-12034 moved ONE of this file's two reads into the predicate module
  // below; the repo-wide count is unchanged at 2. This is the relocation the
  // docstring above anticipates ("a file leaves this map when its read moves
  // into the owning module"), not a new consumer and not a migration.
  "apps/api/app/cron/reconcile-pull-requests/delivery-coverage-metrics.ts": 1,
  "apps/api/app/cron/reconcile-pull-requests/delivery-coverage-predicate.ts": 1,
  "apps/api/app/cron/reconcile-pull-requests/repo-reconciler.ts": 1,
  "apps/api/app/documents/document-pull-request-service.ts": 1,
  "apps/api/app/integrations/github/backfill-projection-writer.ts": 2,
  "apps/api/app/integrations/github/backfill-service.ts": 2,
  "apps/api/app/integrations/github/projection-read.ts": 1,
  "apps/api/app/integrations/github/service/repository-artifact-relink.ts": 17,
  "apps/api/app/integrations/github/sync-service.ts": 6,
  "apps/api/app/integrations/github/tracked-pull-requests.ts": 2,
  "apps/api/app/webhooks/github/handlers/check-run-handler.ts": 3,
  "apps/api/app/webhooks/github/handlers/pr-comment-context.ts": 1,
  "apps/api/app/webhooks/github/handlers/pull-request-handler.ts": 9,
  "apps/api/app/webhooks/github/handlers/pull-request-lifecycle-decision.ts": 2,
  "apps/api/lib/artifact-adapters.ts": 2,
  "apps/api/lib/resolve-pr-context.ts": 8,
};

describe("branch current-PR pointer inventory (ISS-8521)", () => {
  it("scans production source while excluding disposable test-run caches", () => {
    const root = mkdtempSync(join(tmpdir(), "pointer-inventory-"));
    try {
      mkdirSync(join(root, ".cache"));
      const source = join(root, "production.ts");
      writeFileSync(source, "const pointer = row.isCurrent;");
      writeFileSync(
        join(root, ".cache", "entry.ts"),
        "const fixture = row.isCurrent;"
      );
      expect(collectScannedFiles(root, [])).toEqual([source]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  // Explicit, because this parses every production module in `apps/api` with
  // `setParentNodes` — a real bounded cost that grows with the app, not a hang,
  // and one that already ran at ~3s of the 5s default before the detector
  // learned the SQL shapes. A default-timeout flake here reads as a ledger
  // failure, which is the one thing this file must never report falsely.
  it(
    "pins every production read still resolving through the pointer",
    () => {
      expect(scanUnmigratedPointerReads()).toEqual(UNMIGRATED_POINTER_READS);
    },
    SCAN_TIMEOUT_MS
  );

  it("counts a pointer read written in any of the shapes TypeScript allows", () => {
    // The ledger is only as complete as its detector. A reader that saw solely
    // dotted access would let a destructured or bracket-notation pointer read
    // be added at a count of zero — a silent hole in the exact guarantee this
    // file exists to give. Each shape below is one such escape.
    expect(
      countPointerReadsInSource("dotted.ts", "const a = row.isCurrent;")
    ).toBe(1);
    expect(
      countPointerReadsInSource("destructured.ts", "const { isCurrent } = row;")
    ).toBe(1);
    expect(
      countPointerReadsInSource(
        "renamed.ts",
        "const { currentPullRequestDetailId: id } = row;"
      )
    ).toBe(1);
    expect(
      countPointerReadsInSource("indexed.ts", 'const a = row["isCurrent"];')
    ).toBe(1);
    expect(
      countPointerReadsInSource(
        "nested.ts",
        "const a = row.branch.currentPullRequestDetail;"
      )
    ).toBe(1);
    // A quoted or computed key is still a key. `{ ["isCurrent"]: c }` binds
    // through a ComputedPropertyName, so reading `.text` off the name node sees
    // nothing and the read scores zero.
    expect(
      countPointerReadsInSource("quoted.ts", 'const { "isCurrent": c } = row;')
    ).toBe(1);
    expect(
      countPointerReadsInSource(
        "computed.ts",
        'const { ["isCurrent"]: c } = row;'
      )
    ).toBe(1);
    // Resolution done in SQL counts. These are the shapes the ledger was blind
    // to: a filter and a write, both indistinguishable from a select by syntax
    // alone.
    expect(
      countPointerReadsInSource(
        "where.ts",
        "const q = { where: { isCurrent: true } };"
      )
    ).toBe(1);
    expect(
      countPointerReadsInSource(
        "data.ts",
        "const q = { data: { currentPullRequestDetailId: id } };"
      )
    ).toBe(1);
    // A Prisma select KEY is a hydrate, not a decision, and must not count —
    // otherwise every select that merely carries the column reads as a consumer.
    // A hoisted select has no enclosing clause, so both markers that stand in
    // for one are pinned: the `satisfies` annotation (under a name that does NOT
    // end in `Select`, so only the annotation can be doing the work) and the
    // const's name (with no annotation at all, and behind `as const`, which must
    // not stop the walk before the name is reached).
    expect(
      countPointerReadsInSource(
        "select.ts",
        "const q = { select: { isCurrent: true } };"
      )
    ).toBe(0);
    expect(
      countPointerReadsInSource(
        "satisfies.ts",
        "const hydrate = { isCurrent: true } satisfies Prisma.PullRequestDetailSelect;"
      )
    ).toBe(0);
    expect(
      countPointerReadsInSource(
        "hoisted.ts",
        "const branchDetailSelect = { isCurrent: true } as const;"
      )
    ).toBe(0);
    expect(
      countPointerReadsInSource("unrelated.ts", "const a = row.someOtherField;")
    ).toBe(0);
  });

  it("scans production .tsx, not only .ts", () => {
    // `apps/api` carries a layout and an error boundary, and a route added
    // tomorrow reads the same rows. Scanning only `.ts` left the whole
    // extension unscored while the ledger still called itself all-production.
    expect(isScannedSource("apps/api/app/layout.tsx")).toBe(true);
    expect(isScannedSource("apps/api/lib/thing.ts")).toBe(true);
    expect(isScannedSource("apps/api/app/thing.test.tsx")).toBe(false);
    expect(isScannedSource("apps/api/lib/thing.test.ts")).toBe(false);
    expect(isScannedSource("apps/api/app/route.js")).toBe(false);
  });
});

/** Count every direct read of a pointer property, in any syntactic shape. */
function countPointerReadsInSource(fileName: string, text: string): number {
  const sourceFile = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true
  );
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (isPointerRead(node)) {
      count += 1;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return count;
}

function isPointerRead(node: ts.Node): boolean {
  if (ts.isPropertyAccessExpression(node)) {
    return isPointerName(propertyKeyText(node.name));
  }
  if (ts.isBindingElement(node)) {
    // `{ isCurrent }` binds through `name`; `{ isCurrent: renamed }` and
    // `{ ["isCurrent"]: renamed }` through `propertyName`, so the source key is
    // always `propertyName ?? name`.
    return isPointerName(propertyKeyText(node.propertyName ?? node.name));
  }
  if (
    ts.isElementAccessExpression(node) &&
    ts.isStringLiteralLike(node.argumentExpression)
  ) {
    return POINTER_PROPERTY_NAMES.has(node.argumentExpression.text);
  }
  if (ts.isPropertyAssignment(node)) {
    return isPointerName(propertyKeyText(node.name)) && !isHydrateClause(node);
  }
  return false;
}

function isPointerName(key: string | undefined): boolean {
  return key !== undefined && POINTER_PROPERTY_NAMES.has(key);
}

/**
 * The source key a property name node names. Covers every spelling TypeScript
 * allows for one: bare, quoted, and computed from a string literal. A computed
 * key is a `ComputedPropertyName` wrapping the literal, so reading `.text` off
 * the name node itself sees nothing.
 */
function propertyKeyText(name: ts.Node): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) {
    return name.text;
  }
  if (
    ts.isComputedPropertyName(name) &&
    ts.isStringLiteralLike(name.expression)
  ) {
    return name.expression.text;
  }
  return undefined;
}

/**
 * Whether an object-literal key merely hydrates the column rather than deciding
 * with it. `select` / `include` carry it; every other clause — `where`, `data`,
 * `orderBy` — resolves the pointer, which is the read this ledger exists to
 * count. `where: { isCurrent: true }` and `select: { isCurrent: true }` are the
 * same syntax, so the enclosing clause is the ONLY thing separating them, and
 * `setParentNodes` is what makes it reachable. A literal with no enclosing
 * clause counts unless it is marked a select by `satisfies`: un-attributable is
 * scored as a read so a new shape surfaces as a ledger entry rather than a
 * silent zero.
 */
function isHydrateClause(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isPropertyAssignment(current)) {
      const key = propertyKeyText(current.name);
      return key !== undefined && HYDRATE_CLAUSE_NAMES.has(key);
    }
    if (
      (ts.isSatisfiesExpression(current) || ts.isAsExpression(current)) &&
      namesHydrateShape(current.type.getText())
    ) {
      return true;
    }
    if (
      ts.isVariableDeclaration(current) &&
      namesHydrateShape(current.name.getText())
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function namesHydrateShape(text: string): boolean {
  return HYDRATE_SHAPE_SUFFIXES.some((suffix) => text.endsWith(suffix));
}

/** Production `apps/api` modules: no tests, fixtures, or ops scripts. */
function collectScannedFiles(dir: string, found: string[]): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (
      entry === "node_modules" ||
      entry === ".next" ||
      entry === ".cache" ||
      entry === "__tests__"
    ) {
      continue;
    }
    if (statSync(path).isDirectory()) {
      collectScannedFiles(path, found);
    } else if (isScannedSource(path)) {
      found.push(path);
    }
  }
  return found;
}

/** Production TypeScript, `.tsx` included: a route or layout reads the same rows. */
function isScannedSource(path: string): boolean {
  if (path.endsWith(".test.ts") || path.endsWith(".test.tsx")) {
    return false;
  }
  return path.endsWith(".ts") || path.endsWith(".tsx");
}

function scanUnmigratedPointerReads(): Record<string, number> {
  const inventory: Record<string, number> = {};
  for (const absolute of collectScannedFiles(API_ROOT, [])) {
    const file = relative(REPO_ROOT, absolute).split(sep).join("/");
    if (OWNING_MODULES.has(file) || file.startsWith("apps/api/scripts/")) {
      continue;
    }
    const count = countPointerReadsInSource(
      file,
      readFileSync(absolute, "utf8")
    );
    if (count > 0) {
      inventory[file] = count;
    }
  }
  return inventory;
}
