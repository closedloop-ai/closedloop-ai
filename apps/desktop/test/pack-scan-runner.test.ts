/**
 * FEA-3628 — the db-host-side runner that drives the pure-compute pack-scan
 * utilityProcess. Uses a fake fork (no real Electron process) to exercise the
 * request/response, failure, invalid-payload, and timeout paths.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { Harness } from "@repo/api/src/types/agent-component";
import type { PackScanComputeResult } from "../src/main/packs/pack-scanner.js";
import { createUtilityProcessPackScanRunner } from "../src/main/packs/utility-process-pack-scan-runner.js";

function computeResult(): PackScanComputeResult {
  return {
    plan: {
      packs: [
        {
          pack_id: "p",
          harness: "claude",
          install_path: "/x",
          install_kind: "directory",
          version: "1",
        },
      ],
      skills: [],
      associations: [],
    },
    counts: {
      gstack: { installs: 1, skills: 0 },
      bmad: { installs: 0, skills: 0, projects: 0 },
      marketplaces: { installs: 0, skills: 0, marketplaces: 0 },
      catalogDetectors: {},
      gstackProjects: 0,
    },
    scopes: {
      gstack: true,
      bmad: true,
      marketplaces: true,
      gstackProjects: true,
      catalogDetectors: true,
    },
  };
}

const SCAN_BLEW_UP = /scan blew up/;
const INVALID_RESPONSE = /invalid response/;
const EXITED_CODE_1 = /exited with code 1/;
const TIMED_OUT = /timed out/;
const MISMATCHED_REPLY = /replied "computed" to a "definitions" request/;

class FakeUtilityProcess extends EventEmitter {
  readonly stderr = new EventEmitter();
  readonly messages: Array<{ requestId: string }> = [];
  killed = false;
  postMessage(message: { requestId: string }): void {
    this.messages.push(message);
  }
  kill(): void {
    this.killed = true;
  }
}

test("runner resolves with the worker's computed plan", async () => {
  const children: FakeUtilityProcess[] = [];
  const runner = createUtilityProcessPackScanRunner({
    forkWorker: () => {
      const child = new FakeUtilityProcess();
      children.push(child);
      return child;
    },
  });

  const promise = runner.computeScan(["/proj/a"]);
  const child = children[0]!;
  const requestId = child.messages[0]!.requestId;
  child.emit("message", {
    type: "computed",
    requestId,
    result: computeResult(),
  });

  const result = await promise;
  assert.equal(result.plan.packs.length, 1);
  assert.equal(result.counts.gstack.installs, 1);
  runner.stop();
});

test("runner rejects on a worker failure response", async () => {
  const children: FakeUtilityProcess[] = [];
  const runner = createUtilityProcessPackScanRunner({
    forkWorker: () => {
      const child = new FakeUtilityProcess();
      children.push(child);
      return child;
    },
  });
  const promise = runner.computeScan([]);
  const child = children[0]!;
  child.emit("message", {
    type: "failed",
    requestId: child.messages[0]!.requestId,
    message: "scan blew up",
  });
  await assert.rejects(promise, SCAN_BLEW_UP);
  runner.stop();
});

test("runner rejects and kills the child on an invalid response payload", async () => {
  const logs: string[] = [];
  const children: FakeUtilityProcess[] = [];
  const runner = createUtilityProcessPackScanRunner({
    log: (m) => logs.push(m),
    forkWorker: () => {
      const child = new FakeUtilityProcess();
      children.push(child);
      return child;
    },
  });
  const promise = runner.computeScan([]);
  const child = children[0]!;
  // Missing `result` for a "computed" response — fails schema validation.
  child.emit("message", {
    type: "computed",
    requestId: child.messages[0]!.requestId,
  });
  await assert.rejects(promise, INVALID_RESPONSE);
  assert.equal(child.killed, true);
  runner.stop();
});

test("runner rejects when the worker exits before responding", async () => {
  const children: FakeUtilityProcess[] = [];
  const runner = createUtilityProcessPackScanRunner({
    forkWorker: () => {
      const child = new FakeUtilityProcess();
      children.push(child);
      return child;
    },
  });
  const promise = runner.computeScan([]);
  children[0]!.emit("exit", 1);
  await assert.rejects(promise, EXITED_CODE_1);
  runner.stop();
});

test("runner times out a hung worker", async () => {
  const children: FakeUtilityProcess[] = [];
  const runner = createUtilityProcessPackScanRunner({
    scanTimeoutMs: 20,
    forkWorker: () => {
      const child = new FakeUtilityProcess();
      children.push(child);
      return child;
    },
  });
  const promise = runner.computeScan([]);
  await assert.rejects(promise, TIMED_OUT);
  assert.equal(children[0]!.killed, true);
  runner.stop();
});

// ---------------------------------------------------------------------------
// ISS-5274 — the definitions request rides the same child and protocol.
// ---------------------------------------------------------------------------

test("runner round-trips a definitions request and resolves the walked payload", async () => {
  const children: FakeUtilityProcess[] = [];
  const runner = createUtilityProcessPackScanRunner({
    forkWorker: () => {
      const child = new FakeUtilityProcess();
      children.push(child);
      return child;
    },
  });

  const promise = runner.computeDefinitions({
    skillRoots: [{ dir: "/home/u/.claude/skills", harness: Harness.Claude }],
  });
  const child = children[0]!;
  const sent = child.messages[0] as unknown as {
    type: string;
    requestId: string;
    scanRoots: { skillRoots: { dir: string }[] };
  };
  // The roots the db-host resolved must reach the worker unchanged — the worker
  // reads no environment of its own and cannot re-derive them.
  assert.equal(sent.type, "definitions");
  assert.deepEqual(sent.scanRoots.skillRoots, [
    { dir: "/home/u/.claude/skills", harness: Harness.Claude },
  ]);

  child.emit("message", {
    type: "definitions",
    requestId: sent.requestId,
    definitions: [
      {
        primary: {
          kind: "skill",
          externalId: "s",
          name: "s",
          installPath: "/home/u/.claude/skills/s/SKILL.md",
          content: "body",
          harness: Harness.Claude,
        },
        variants: [],
      },
    ],
  });

  const outcome = await promise;
  assert.equal(outcome.omitted, false);
  assert.equal(outcome.omitted === false && outcome.definitions.length, 1);
  runner.stop();
});

test("an omitted response resolves normally and does not kill the child", async () => {
  const children: FakeUtilityProcess[] = [];
  const runner = createUtilityProcessPackScanRunner({
    forkWorker: () => {
      const child = new FakeUtilityProcess();
      children.push(child);
      return child;
    },
  });

  const promise = runner.computeDefinitions({});
  const child = children[0]!;
  child.emit("message", {
    type: "definitionsOmitted",
    requestId: child.messages[0]!.requestId,
    reason: "definition count 60000 exceeds 50000",
  });

  const outcome = await promise;
  // Omission is a healthy answer — the walk ran, the payload was too big to
  // ship — so it must NOT be treated as a worker failure. Killing the child
  // here would make an over-budget machine re-fork a worker on every scan.
  assert.equal(outcome.omitted, true);
  assert.equal(
    outcome.omitted === true && outcome.reason,
    "definition count 60000 exceeds 50000"
  );
  assert.equal(child.killed, false, "an omission must not kill the child");
  runner.stop();
});

test("a computed reply to a definitions request rejects instead of resolving the wrong shape", async () => {
  const children: FakeUtilityProcess[] = [];
  const runner = createUtilityProcessPackScanRunner({
    forkWorker: () => {
      const child = new FakeUtilityProcess();
      children.push(child);
      return child;
    },
  });

  const promise = runner.computeDefinitions({});
  const child = children[0]!;
  child.emit("message", {
    type: "computed",
    requestId: child.messages[0]!.requestId,
    result: computeResult(),
  });

  // A scan plan is not a definition set; resolving it here would hand the
  // db-host a payload of the wrong shape to apply.
  await assert.rejects(promise, MISMATCHED_REPLY);
  runner.stop();
});
