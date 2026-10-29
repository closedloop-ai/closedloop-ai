/**
 * @file shared-agent-components-ipc-cloneable.test.ts
 * @description ISS-6409 (#6417 review fallout): the desktop-local inventory
 * response that crosses IPC must be structured-cloneable.
 *
 * `ipcMain.handle(SHARED_AGENT_COMPONENTS_IPC_CHANNELS.list, ...)` returns
 * `listAgentComponentsLocal`'s result straight across the process boundary,
 * where Electron structured-clones it. A function on that object throws
 * `DataCloneError` and takes down EVERY Agents read — which is exactly what
 * putting the LOC/$ population fold on this response did: all of the Agents
 * desktop e2e specs timed out at once, and no unit test noticed, because within
 * a single process the extra key is harmless.
 *
 * SCOPE, precisely: this pins the READER's return shape, not the handler
 * registration. Repointing the `list` channel at the fold-carrying reader would
 * reintroduce the defect and leave these cases green. The `pageData` channel's
 * registration IS covered end to end, by
 * `test/e2e/agents-summary-loc-per-dollar-fold.spec.ts`, which drives it
 * through real IPC in a launched app; the `list` channel's is not.
 *
 * Its own file rather than an addition to `shared-agent-components-api.test.ts`
 * because that file is at the grandfathered line ceiling and is shrink-only,
 * and because this is a boundary contract rather than an inventory-projection
 * assertion.
 */

import assert from "node:assert/strict";
import { test } from "vitest";
import {
  listAgentComponentsLocal,
  listAgentComponentsLocalWithLocPerDollarFold,
} from "../src/main/dashboard/shared-agent-components-api.js";
import { insertComponent } from "./agent-components-test-fixtures.js";
import { openTestPrisma } from "./prisma-test-utils.js";

test("the IPC inventory response carries no functions", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await insertComponent(prisma, {
      id: "c-clone",
      kind: "subagent",
      externalId: "ext-clone",
      key: "clone-check",
    });

    const result = await listAgentComponentsLocal(prisma, {});

    // `structuredClone` rather than a key inventory: it rejects ANY
    // non-cloneable value a future field might carry, not just the one that
    // caused this.
    assert.doesNotThrow(() => structuredClone(result));
    assert.equal(
      Object.hasOwn(result as object, "foldLocPerDollar"),
      false,
      "the IPC response must not carry the LOC/$ fold"
    );
  } finally {
    await close();
  }
});

test("the in-process reader still exposes the LOC/$ fold", async () => {
  // The sibling half of the split: the fold has to exist somewhere, or the
  // page-data reducer silently loses the metric and the card reads a dash.
  const { prisma, close } = await openTestPrisma();
  try {
    await insertComponent(prisma, {
      id: "c-fold",
      kind: "subagent",
      externalId: "ext-fold",
      key: "fold-check",
    });

    const withFold = await listAgentComponentsLocalWithLocPerDollarFold(
      prisma,
      {}
    );

    assert.equal(typeof withFold.foldLocPerDollar, "function");
  } finally {
    await close();
  }
});
