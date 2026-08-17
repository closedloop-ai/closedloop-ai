import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { AgentComponentKind } from "@repo/api/src/types/agent-component.js";
import {
  ConvertFailureClass,
  ConvertInstallState,
  isPermanentFailure,
  makeConvertInstallErrorOutcome,
} from "@repo/api/src/types/convert-install.js";
import { ConversionSupport } from "@repo/api/src/types/harness-conversion.js";
import { HarnessName } from "@repo/crewd/model";
import {
  type ConvertInstallRunner,
  classifyStreamRunError,
  convertInstall,
} from "../src/main/packs/convert-engine.js";
import type { StreamRunResult } from "../src/shared/install-run-contract.js";

// A runner that records its calls and returns a scripted StreamRunResult. Lets
// each test drive convertInstall through the real production path and assert the
// outcome AND whether the install path was even reached.
function makeRunner(result: StreamRunResult | null): {
  runner: ConvertInstallRunner;
  calls: Array<{ packId: string; harness: HarnessName; cwd?: string }>;
} {
  const calls: Array<{ packId: string; harness: HarnessName; cwd?: string }> =
    [];
  const runner: ConvertInstallRunner = (packId, harness, cwd) => {
    calls.push({ packId, harness, cwd });
    return Promise.resolve(result);
  };
  return { runner, calls };
}

describe("convertInstall — honest boundary state", () => {
  test("lossless convert reports Converting and runs the existing install path", async () => {
    // Skill is PORTABLE (supported) across every harness → lossless.
    const { runner, calls } = makeRunner({ started: true, runId: 42 });
    const outcome = await convertInstall(
      {
        packId: "acme/skill-pack",
        name: "Acme Skill",
        kind: AgentComponentKind.Skill,
        currentHarness: HarnessName.Claude,
        targetHarness: HarnessName.Codex,
      },
      runner
    );

    assert.equal(outcome.state, ConvertInstallState.Converting);
    assert.equal(outcome.capability.support, ConversionSupport.Supported);
    assert.deepEqual(outcome.droppedFields, []);
    assert.equal(outcome.runId, 42);
    assert.equal(outcome.failureClass, undefined);
    // The install path WAS reached, targeting the requested harness.
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.packId, "acme/skill-pack");
    assert.equal(calls[0]?.harness, HarnessName.Codex);
  });

  test("lossy convert reports Partial with dropped fields — NOT a silent success", async () => {
    // Subagent claude→codex is PARTIAL (drops model, allowedTools).
    const { runner, calls } = makeRunner({ started: true, runId: 7 });
    const outcome = await convertInstall(
      {
        packId: "acme/subagent-pack",
        name: "Acme Subagent",
        kind: AgentComponentKind.Subagent,
        currentHarness: HarnessName.Claude,
        targetHarness: HarnessName.Codex,
      },
      runner
    );

    // The boundary is honest about the loss: Partial, not Installed/Converting.
    assert.equal(outcome.state, ConvertInstallState.Partial);
    assert.notEqual(outcome.state, ConvertInstallState.Installed);
    assert.notEqual(outcome.state, ConvertInstallState.Converting);
    assert.equal(outcome.capability.support, ConversionSupport.Partial);
    assert.deepEqual(outcome.droppedFields, ["model", "allowedTools"]);
    // Still installed (partial ⇒ the install path ran) and message names the loss.
    assert.equal(calls.length, 1);
    assert.ok(outcome.message?.includes("model"));
    assert.ok(outcome.message?.includes("allowedTools"));
  });

  test("unsupported convert reports Unsupported + not_applicable and installs NOTHING", async () => {
    // Hook is UNSUPPORTED cross-harness (no equivalent event surface).
    const { runner, calls } = makeRunner({ started: true, runId: 99 });
    const outcome = await convertInstall(
      {
        packId: "acme/hook-pack",
        name: "Acme Hook",
        kind: AgentComponentKind.Hook,
        currentHarness: HarnessName.Claude,
        targetHarness: HarnessName.Codex,
      },
      runner
    );

    assert.equal(outcome.state, ConvertInstallState.Unsupported);
    assert.equal(outcome.capability.support, ConversionSupport.Unsupported);
    assert.equal(outcome.failureClass, ConvertFailureClass.NotApplicable);
    assert.equal(isPermanentFailure(outcome.failureClass!), true);
    // Critical: no silent lossy write — the install path was NEVER reached.
    assert.equal(calls.length, 0);
    assert.equal(outcome.runId, undefined);
  });
});

describe("convertInstall — transient vs permanent classification", () => {
  test("a permanent install rejection (ENOCOMMAND) is classified permanent", async () => {
    const { runner } = makeRunner({
      started: false,
      error: { code: "ENOCOMMAND", message: "no install command" },
    });
    const outcome = await convertInstall(
      {
        packId: "acme/skill-pack",
        name: "Acme Skill",
        kind: AgentComponentKind.Skill,
        currentHarness: HarnessName.Claude,
        targetHarness: HarnessName.Codex,
      },
      runner
    );

    assert.equal(outcome.state, ConvertInstallState.Error);
    assert.equal(outcome.failureClass, ConvertFailureClass.Permanent);
    assert.equal(isPermanentFailure(outcome.failureClass!), true);
  });

  test("a transient install rejection (ENOCLI) stays retry-eligible", async () => {
    const { runner } = makeRunner({
      started: false,
      error: { code: "ENOCLI", message: "no supported CLI on PATH" },
    });
    const outcome = await convertInstall(
      {
        packId: "acme/skill-pack",
        name: "Acme Skill",
        kind: AgentComponentKind.Skill,
        currentHarness: HarnessName.Claude,
        targetHarness: HarnessName.Codex,
      },
      runner
    );

    assert.equal(outcome.state, ConvertInstallState.Error);
    assert.equal(outcome.failureClass, ConvertFailureClass.Transient);
    assert.equal(isPermanentFailure(outcome.failureClass!), false);
  });

  test("runtime-not-ready (null result) is a transient error", async () => {
    const { runner } = makeRunner(null);
    const outcome = await convertInstall(
      {
        packId: "acme/skill-pack",
        name: "Acme Skill",
        kind: AgentComponentKind.Skill,
        currentHarness: HarnessName.Claude,
        targetHarness: HarnessName.Codex,
      },
      runner
    );

    assert.equal(outcome.state, ConvertInstallState.Error);
    assert.equal(outcome.failureClass, ConvertFailureClass.Transient);
  });

  test("a REJECTING runner (streamRun DB failure) is caught as a transient error, not a thrown IPC promise", async () => {
    // streamRun can reject before returning a StreamRunResult when its catalog or
    // run-record DB calls throw; that must surface as a typed transient error
    // outcome, not a rejected IPC promise the renderer can't classify.
    const runner: ConvertInstallRunner = () =>
      Promise.reject(new Error("SQLITE_BUSY: database is locked"));

    const outcome = await convertInstall(
      {
        packId: "acme/skill-pack",
        name: "Acme Skill",
        kind: AgentComponentKind.Skill,
        currentHarness: HarnessName.Claude,
        targetHarness: HarnessName.Codex,
      },
      runner
    );

    assert.equal(outcome.state, ConvertInstallState.Error);
    assert.equal(outcome.failureClass, ConvertFailureClass.Transient);
    assert.equal(isPermanentFailure(outcome.failureClass!), false);
    // The outcome stays contract-complete even on the caught path: the resolved
    // capability and echoed identity are present, so a consumer never derefs
    // undefined.
    assert.equal(outcome.capability.support, ConversionSupport.Supported);
    assert.equal(outcome.identity.id, "acme/skill-pack");
    assert.ok(outcome.message?.includes("database is locked"));
  });

  test("classifyStreamRunError maps known codes and degrades unknown to transient", () => {
    assert.equal(
      classifyStreamRunError("EINFLIGHT"),
      ConvertFailureClass.Transient
    );
    assert.equal(
      classifyStreamRunError("ENOTFOUND"),
      ConvertFailureClass.Permanent
    );
    assert.equal(
      classifyStreamRunError("EBADCWD"),
      ConvertFailureClass.Permanent
    );
    // Version-skew: an unrecognized code from a peer is retryable, not a silent
    // permanent dead-end.
    assert.equal(
      classifyStreamRunError("E_FROM_NEWER_PEER"),
      ConvertFailureClass.Transient
    );
    assert.equal(
      classifyStreamRunError(undefined),
      ConvertFailureClass.Transient
    );
  });
});

describe("convertInstall — provenance (FEA-4028)", () => {
  test("preserves an explicit sourceHarness across a convert hop", async () => {
    // A component authored for claude, currently in codex format, converting to
    // opencode: provenance must remain claude, not be overwritten by currentHarness.
    const { runner } = makeRunner({ started: true, runId: 1 });
    const outcome = await convertInstall(
      {
        packId: "acme/skill-pack",
        name: "Acme Skill",
        kind: AgentComponentKind.Skill,
        currentHarness: HarnessName.Codex,
        targetHarness: HarnessName.Opencode,
        sourceHarness: HarnessName.Claude,
      },
      runner
    );

    assert.equal(outcome.identity.sourceHarness, HarnessName.Claude);
    assert.equal(outcome.identity.currentHarness, HarnessName.Codex);
    assert.equal(outcome.identity.targetHarness, HarnessName.Opencode);
  });

  test("defaults provenance to currentHarness for a never-converted component", async () => {
    const { runner } = makeRunner({ started: true, runId: 1 });
    const outcome = await convertInstall(
      {
        packId: "acme/skill-pack",
        name: "Acme Skill",
        kind: AgentComponentKind.Skill,
        currentHarness: HarnessName.Codex,
        targetHarness: HarnessName.Opencode,
      },
      runner
    );

    assert.equal(outcome.identity.sourceHarness, HarnessName.Codex);
  });

  test("provenance is preserved even on an unsupported (skipped) convert", async () => {
    const { runner, calls } = makeRunner({ started: true, runId: 1 });
    const outcome = await convertInstall(
      {
        packId: "acme/hook-pack",
        name: "Acme Hook",
        kind: AgentComponentKind.Hook,
        currentHarness: HarnessName.Codex,
        targetHarness: HarnessName.Claude,
        sourceHarness: HarnessName.Claude,
      },
      runner
    );

    assert.equal(outcome.state, ConvertInstallState.Unsupported);
    assert.equal(outcome.identity.sourceHarness, HarnessName.Claude);
    assert.equal(calls.length, 0);
  });
});

describe("makeConvertInstallErrorOutcome — contract-complete boundary errors", () => {
  test("a disabled/invalid boundary path yields every required ConvertInstallOutcome field", () => {
    // The disabled-runtime and invalid-request paths never reach the engine, but
    // the `Promise<ConvertInstallOutcome>` contract still requires identity,
    // capability, and droppedFields — a partial `{ state, failureClass, message }`
    // literal lets a consumer deref undefined. The builder fills them.
    const outcome = makeConvertInstallErrorOutcome({
      failureClass: ConvertFailureClass.Transient,
      message: "Agent Dashboard is disabled in Settings.",
    });

    assert.equal(outcome.state, ConvertInstallState.Error);
    assert.equal(outcome.failureClass, ConvertFailureClass.Transient);
    // Required fields present (not undefined) so no consumer derefs past them.
    assert.ok(outcome.identity);
    assert.ok(outcome.capability);
    assert.deepEqual(outcome.droppedFields, []);
    assert.equal(outcome.capability.support, ConversionSupport.Unsupported);
    assert.deepEqual(outcome.capability.droppedFields, []);
  });

  test("echoes a supplied identity when the request was known", () => {
    const identity = {
      id: "acme/skill-pack",
      name: "Acme Skill",
      kind: AgentComponentKind.Skill,
      sourceHarness: HarnessName.Claude,
      currentHarness: HarnessName.Claude,
      targetHarness: HarnessName.Codex,
    };
    const outcome = makeConvertInstallErrorOutcome({
      failureClass: ConvertFailureClass.Transient,
      message: "boom",
      identity,
    });

    assert.equal(outcome.identity.id, "acme/skill-pack");
    assert.equal(outcome.identity.targetHarness, HarnessName.Codex);
  });
});

describe("ConvertInstallState — literal parity with the UI display vocabulary", () => {
  test("overlapping states carry the same wire literals as PackInstallState", () => {
    // The convert engine (main process) cannot import @repo/app's PackInstallState
    // (JSX/design-system deps unreachable in main), so the overlap is a documented
    // literal contract. Pin the wire values so a rename on either side is caught
    // here and in the renderer parity guard. (Values: FEA-4083 install-state.ts.)
    assert.equal(ConvertInstallState.Converting, "converting");
    assert.equal(ConvertInstallState.Installed, "installed");
    assert.equal(ConvertInstallState.Unsupported, "unsupported");
  });
});
