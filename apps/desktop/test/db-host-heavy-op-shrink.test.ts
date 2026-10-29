/**
 * @file db-host-heavy-op-shrink.test.ts
 * @description ISS-12023 (PRD-785) — a heavy-gate op hands its page cache back.
 *
 * `idle-shrink-memory.test.ts` proves the store-side pass; this file proves the
 * other trigger, which is three separate things that can each fail silently:
 *
 * 1. the EXCLUSIVE lane announces a settled op, and the bounded/ungated lanes do
 *    NOT (reclaiming after every interactive page load would spend the page
 *    cache's hit rate on the surfaces that need it);
 * 2. `db-host-worker.ts` actually passes that hook — nothing executable can
 *    check it, because the worker registers a `process.parentPort` listener at
 *    load, so the connection is read from the AST, the same guard
 *    `db-host-insights-epoch-wiring.test.ts` applies for the same reason;
 * 3. the dotted op path the hook sends resolves to a live method on the real
 *    store and shrinks it. A string that resolves to nothing would make the
 *    reclaim quietly stop happening, which is invisible from either end.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Node, SourceFile } from "typescript6";
import {
  createSourceFile,
  forEachChild,
  isCallExpression,
  isIdentifier,
  isPropertyAssignment,
  ScriptKind,
  ScriptTarget,
} from "typescript6";
import { describe, it } from "vitest";
import {
  callDbHostOp,
  PRISMA_SHRINK_MEMORY_OP,
} from "../src/main/database/db-host/db-host-invoke-dispatch.js";
import {
  BOUNDED_READ_OPS,
  DB_HOST_EXCLUSIVE_OP,
} from "../src/main/database/db-host/db-host-op-lane-registry.js";
import {
  createDbHostOpLanes,
  HEAVY_STORE_OPS,
} from "../src/main/database/db-host/db-host-op-lanes.js";
import { SKILL_SHADOW_INVENTORY_REPAIR_OP } from "../src/main/database/skill-shadow-inventory-repair-boundary.js";
import { createWriteQueue } from "../src/main/database/write-queue.js";
import { openTestPrisma } from "./prisma-test-utils.js";

const BOOM = /boom/;
/** A `store:` key in `HEAVY_STORE_OPS`, read from the set rather than retyped. */
const HEAVY_STORE_KEY = [...HEAVY_STORE_OPS][0] as string;
/** A member of the BOUNDED read lane, likewise read from the registry. */
const BOUNDED_OP = [...BOUNDED_READ_OPS][0] as string;
/**
 * An op in neither set, so it runs ungated. The routing decision is pure set
 * membership, so a synthetic name exercises the real branch.
 */
const UNGATED_OP = "lane-test.ungated";
/** Writer + the 2-reader pool: what a pass over an idle store must report. */
const EVERY_CONNECTION = 3;

describe("the exclusive lane announces a settled heavy op", () => {
  it("fires once per heavy store op, and never for a bounded or ungated one", async () => {
    let settled = 0;
    const lanes = createDbHostOpLanes({
      onExclusiveSettled: () => {
        settled += 1;
      },
    });

    await lanes.runStoreOp(HEAVY_STORE_KEY, () => Promise.resolve("heavy"));
    assert.equal(settled, 1);

    await lanes.runInvokeOp(BOUNDED_OP, () => Promise.resolve("bounded"));
    await lanes.runInvokeOp(UNGATED_OP, () => Promise.resolve("ungated"));
    await lanes.runStoreOp(SKILL_SHADOW_INVENTORY_REPAIR_OP, () =>
      Promise.resolve("cheap store op")
    );
    assert.equal(
      settled,
      1,
      "only the EXCLUSIVE lane reclaims; the interactive lanes keep their cache"
    );

    // The insights recompute takes the gate through `runExclusive` directly
    // rather than through `runStoreOp`, so it has to be covered on its own path.
    await lanes.runExclusive(() => Promise.resolve(DB_HOST_EXCLUSIVE_OP));
    assert.equal(settled, 2);
  });

  it("fires for a heavy op that threw, which still touched pages", async () => {
    let settled = 0;
    const lanes = createDbHostOpLanes({
      onExclusiveSettled: () => {
        settled += 1;
      },
    });

    await assert.rejects(
      lanes.runStoreOp(HEAVY_STORE_KEY, () =>
        Promise.reject(new Error("boom"))
      ),
      BOOM
    );

    assert.equal(settled, 1);
  });

  it("leaves the lanes routing unchanged when no hook is wired", async () => {
    // Production allocates no wrapper when the dispatcher passes nothing; this
    // pins that the un-hooked lane still routes and returns the op's value.
    const lanes = createDbHostOpLanes();
    assert.equal(
      await lanes.runStoreOp(HEAVY_STORE_KEY, () => Promise.resolve("heavy")),
      "heavy"
    );
  });
});

describe("the op path the hook sends", () => {
  it("resolves against a real store and shrinks every connection", async () => {
    const passes: number[] = [];
    const { prisma, close } = await openTestPrisma(createWriteQueue(), {
      readerPoolSize: EVERY_CONNECTION - 1,
      idleShrinkIntervalMs: 60_000,
      onShrinkMemory: (shrunk) => passes.push(shrunk),
    });
    try {
      // Exactly what the store thread does with the op string: resolve the
      // dotted path against the open runtime and call it.
      await callDbHostOp({ prisma }, PRISMA_SHRINK_MEMORY_OP, []);
      assert.deepEqual(passes, [EVERY_CONNECTION]);
    } finally {
      await close();
    }
  });
});

describe("db-host-worker wiring", () => {
  it("hands createDbHostOpLanes a hook that sends the shrink op to the store", () => {
    const source = parse(WORKER_PATH);
    const lanesCall = findCallTo(source, LANES_FACTORY);
    assert.ok(lanesCall, `db-host-worker.ts must call ${LANES_FACTORY}`);

    const hook = findProperty(lanesCall, source, EXCLUSIVE_SETTLED_PROPERTY);
    assert.ok(
      hook,
      `${EXCLUSIVE_SETTLED_PROPERTY} must be wired, or a heavy op never reclaims`
    );

    // The property existing is not the contract — what it DOES is. A hook wired
    // to something that resolves to nothing would leave this file green while
    // the reclaim silently stopped.
    const used = identifiersUnder(hook, source);
    assert.ok(
      used.includes(SHRINK_OP_IDENTIFIER),
      `the hook must send ${SHRINK_OP_IDENTIFIER}`
    );
    assert.ok(
      used.includes(STORE_CLIENT_IDENTIFIER),
      `the hook must reach the store through ${STORE_CLIENT_IDENTIFIER}`
    );
  });
});

const DB_HOST_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/main/database/db-host"
);
const WORKER_PATH = path.join(DB_HOST_DIR, "db-host-worker.ts");
const LANES_FACTORY = "createDbHostOpLanes";
const EXCLUSIVE_SETTLED_PROPERTY = "onExclusiveSettled";
const SHRINK_OP_IDENTIFIER = "PRISMA_SHRINK_MEMORY_OP";
const STORE_CLIENT_IDENTIFIER = "storeClient";

function parse(file: string): SourceFile {
  return createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ScriptTarget.Latest,
    true,
    ScriptKind.TS
  );
}

/** The first `name(...)` call expression under `source`, or null. */
function findCallTo(source: SourceFile, name: string): Node | null {
  let found: Node | null = null;
  const visit = (node: Node): void => {
    if (found !== null) {
      return;
    }
    if (
      isCallExpression(node) &&
      isIdentifier(node.expression) &&
      node.expression.text === name
    ) {
      found = node;
      return;
    }
    forEachChild(node, visit);
  };
  forEachChild(source, visit);
  return found;
}

/** The object-literal property named `name` under `root`, or null. */
function findProperty(
  root: Node,
  source: SourceFile,
  name: string
): Node | null {
  let found: Node | null = null;
  const visit = (node: Node): void => {
    if (found !== null) {
      return;
    }
    if (isPropertyAssignment(node) && node.name.getText(source) === name) {
      found = node;
      return;
    }
    forEachChild(node, visit);
  };
  forEachChild(root, visit);
  return found;
}

/** Every identifier appearing under `root`. */
function identifiersUnder(root: Node, source: SourceFile): string[] {
  const names: string[] = [];
  const visit = (node: Node): void => {
    if (isIdentifier(node)) {
      names.push(node.getText(source));
    }
    forEachChild(node, visit);
  };
  forEachChild(root, visit);
  return names;
}
