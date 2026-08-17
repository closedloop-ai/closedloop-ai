import { describe, expect, it } from "vitest";
import { runCascade } from "../src/harness/cascade.js";
import { cascadeStepSchema, DEFAULT_MODEL } from "../src/model.js";
import {
  mockHarness as mock,
  registry,
  res,
} from "./helpers/harness-fixtures.js";

const baseOpts = { prompt: "p", cwd: "/tmp", sleep: async () => {} };

const ELICIT_NOTE_RE = /elicit/i;
const NEXT_HARNESS_NOTE_RE = /cascading to next harness/i;
const NO_HARNESS_LEFT_NOTE_RE = /no harness left to cascade/i;

describe("runCascade", () => {
  it("returns the first harness that succeeds", async () => {
    const codex = mock("codex", [res({ ok: true, exitCode: 0 })]);
    const claude = mock("claude", [res({ ok: true, exitCode: 0 })]);
    const r = await runCascade({
      ...baseOpts,
      cascade: ["codex", "claude"],
      registry: registry({ codex, claude }),
    });
    expect(r.ok).toBe(true);
    expect(r.harnessUsed).toBe("codex");
    expect(codex.calls()).toBe(1);
    expect(claude.calls()).toBe(0); // never reached
  });

  it("falls through to the next engine on timeout (fresh window, no same-engine retry)", async () => {
    const codex = mock("codex", [res({ timedOut: true })]);
    const claude = mock("claude", [res({ ok: true, exitCode: 0 })]);
    const r = await runCascade({
      ...baseOpts,
      cascade: ["codex", "claude"],
      registry: registry({ codex, claude }),
    });
    expect(r.ok).toBe(true);
    expect(r.harnessUsed).toBe("claude");
    expect(codex.calls()).toBe(1); // timeout does NOT retry the same engine
    expect(r.attempts.map((a) => a.outcome)).toEqual(["timeout", "success"]);
  });

  it("retries transient failures within an engine then succeeds", async () => {
    const codex = mock("codex", [
      res({ outputTail: "rate limit exceeded" }),
      res({ outputTail: "HTTP 503" }),
      res({ ok: true, exitCode: 0 }),
    ]);
    const r = await runCascade({
      ...baseOpts,
      cascade: ["codex"],
      registry: registry({ codex }),
    });
    expect(r.ok).toBe(true);
    expect(codex.calls()).toBe(3);
    expect(r.attempts.map((a) => a.outcome)).toEqual([
      "failed",
      "failed",
      "success",
    ]);
  });

  it("does not retry a non-transient failure; moves to next engine", async () => {
    const codex = mock("codex", [res({ outputTail: "syntax error in file" })]);
    const claude = mock("claude", [res({ ok: true, exitCode: 0 })]);
    const r = await runCascade({
      ...baseOpts,
      cascade: ["codex", "claude"],
      registry: registry({ codex, claude }),
    });
    expect(codex.calls()).toBe(1);
    expect(r.harnessUsed).toBe("claude");
  });

  it("skips unavailable harnesses and fails when all are exhausted", async () => {
    const codex = mock("codex", [res({ ok: true })], false); // unavailable
    const claude = mock("claude", [res({ ok: false })]);
    const r = await runCascade({
      ...baseOpts,
      cascade: ["codex", "claude"],
      registry: registry({ codex, claude }),
    });
    expect(r.ok).toBe(false);
    expect(r.harnessUsed).toBe(null);
    expect(r.attempts[0]?.outcome).toBe("skipped");
    expect(codex.calls()).toBe(0);
  });

  it("threads a step's model into the driver and records it on the attempt", async () => {
    const codex = mock("codex", [res({ ok: true, exitCode: 0 })]);
    const r = await runCascade({
      ...baseOpts,
      cascade: [{ harness: "codex", model: "o3" }],
      registry: registry({ codex }),
    });
    expect(r.ok).toBe(true);
    // The resolved model reached the driver invocation…
    expect(codex.runOpts()[0]?.model).toBe("o3");
    // …and is recorded on the CascadeAttempt.
    expect(r.attempts[0]?.model).toBe("o3");
  });

  it("a bare harness-name step uses the harness's default model", async () => {
    const codex = mock("codex", [res({ ok: true, exitCode: 0 })]);
    const r = await runCascade({
      ...baseOpts,
      cascade: ["codex"], // legacy shape: bare name ⇒ default model
      registry: registry({ codex }),
    });
    expect(r.ok).toBe(true);
    expect(codex.runOpts()[0]?.model).toBe(DEFAULT_MODEL.codex);
    expect(r.attempts[0]?.model).toBe(DEFAULT_MODEL.codex);
  });

  it("accepts the `harness:model` shorthand and threads that model", async () => {
    const claude = mock("claude", [res({ ok: true, exitCode: 0 })]);
    const r = await runCascade({
      ...baseOpts,
      cascade: ["claude:opus"],
      registry: registry({ claude }),
    });
    expect(r.ok).toBe(true);
    expect(claude.runOpts()[0]?.model).toBe("opus");
    expect(r.attempts[0]?.model).toBe("opus");
  });

  it("reclassifies an eliciting clean-exit attempt as failed and cascades when rejectElicitation is on (FEA-4012)", async () => {
    // codex exits 0 but ended by interviewing instead of auditing — nothing can
    // answer (non-interactive), so this is NOT a live success: it must cascade.
    const codex = mock("codex", [
      res({
        ok: true,
        exitCode: 0,
        outputTail:
          "…then interview me to figure out what I need scheduled and when it should run.",
      }),
    ]);
    const claude = mock("claude", [res({ ok: true, exitCode: 0 })]);
    const r = await runCascade({
      ...baseOpts,
      cascade: ["codex", "claude"],
      rejectElicitation: true,
      registry: registry({ codex, claude }),
    });
    expect(r.ok).toBe(true);
    expect(r.harnessUsed).toBe("claude");
    expect(codex.calls()).toBe(1); // one shot — the elicitation cascades, no retry
    expect(r.attempts.map((a) => a.outcome)).toEqual(["failed", "success"]);
    expect(r.attempts[0]?.note).toMatch(ELICIT_NOTE_RE);
    // A next step exists, so the note says it cascades on.
    expect(r.attempts[0]?.note).toMatch(NEXT_HARNESS_NOTE_RE);
  });

  it("does NOT reject an eliciting clean-exit when rejectElicitation is off — custom-task parity (FEA-4012)", async () => {
    // A custom task legitimately ends by asking a question (e.g. drafting an
    // interview question). Without opting in, that clean exit stays a success —
    // it is NOT reclassified, and the next harness never runs.
    const codex = mock("codex", [
      res({
        ok: true,
        exitCode: 0,
        outputTail:
          "Here is the drafted question: What would you like to focus on?",
      }),
    ]);
    const claude = mock("claude", [res({ ok: true, exitCode: 0 })]);
    const r = await runCascade({
      ...baseOpts,
      cascade: ["codex", "claude"],
      // rejectElicitation omitted ⇒ historical "clean exit = success".
      registry: registry({ codex, claude }),
    });
    expect(r.ok).toBe(true);
    expect(r.harnessUsed).toBe("codex");
    expect(claude.calls()).toBe(0); // never reached — codex succeeded
    expect(r.attempts.map((a) => a.outcome)).toEqual(["success"]);
  });

  it("fails the whole cascade when every harness only elicits (FEA-4012)", async () => {
    // No harness ever audits — each just asks a question. The run must FAIL
    // (bounded), not hang or report a false success.
    const elicit = res({
      ok: true,
      exitCode: 0,
      outputTail: "Before I proceed, could you tell me what to review?",
    });
    const codex = mock("codex", [elicit]);
    const claude = mock("claude", [elicit]);
    const r = await runCascade({
      ...baseOpts,
      cascade: ["codex", "claude"],
      rejectElicitation: true,
      registry: registry({ codex, claude }),
    });
    expect(r.ok).toBe(false);
    expect(r.harnessUsed).toBe(null);
    expect(r.attempts.map((a) => a.outcome)).toEqual(["failed", "failed"]);
    // The LAST attempt has no harness to cascade to — its note must say so, not
    // falsely claim it is cascading onward.
    expect(r.attempts[1]?.note).toMatch(NO_HARNESS_LEFT_NOTE_RE);
    expect(r.attempts[1]?.note).not.toMatch(NEXT_HARNESS_NOTE_RE);
  });

  it("a clean exit whose output is not an elicitation still succeeds with rejectElicitation on (FEA-4012)", async () => {
    const codex = mock("codex", [
      res({
        ok: true,
        exitCode: 0,
        outputTail: "scanning docs...\nwrote 2 findings. audit complete.",
      }),
    ]);
    const r = await runCascade({
      ...baseOpts,
      cascade: ["codex"],
      rejectElicitation: true,
      registry: registry({ codex }),
    });
    expect(r.ok).toBe(true);
    expect(r.harnessUsed).toBe("codex");
    expect(r.attempts[0]?.outcome).toBe("success");
  });

  it("does not reclassify polite completion prose as an elicitation (FEA-4012)", async () => {
    // A FINISHED audit that offers further help must stay a success even with
    // rejectElicitation on — it is done, not blocked on input.
    const codex = mock("codex", [
      res({
        ok: true,
        exitCode: 0,
        outputTail:
          "Completed the audit. Findings written.\nPlease let me know if you want anything else.",
      }),
    ]);
    const r = await runCascade({
      ...baseOpts,
      cascade: ["codex"],
      rejectElicitation: true,
      registry: registry({ codex }),
    });
    expect(r.ok).toBe(true);
    expect(r.attempts[0]?.outcome).toBe("success");
  });

  it("defaults each attempt to a bounded per-attempt timeout (FEA-4012)", async () => {
    const codex = mock("codex", [res({ ok: true, exitCode: 0 })]);
    const r = await runCascade({
      ...baseOpts,
      cascade: ["codex"],
      // perAttemptTimeoutMs omitted ⇒ the shared bounded default reaches the harness.
      registry: registry({ codex }),
    });
    expect(r.ok).toBe(true);
    const seen = codex.runOpts()[0]?.timeoutMs;
    expect(typeof seen === "number" && seen > 0).toBe(true);
  });

  it("honors an explicit 0 per-attempt timeout as unbounded (FEA-4012)", async () => {
    const codex = mock("codex", [res({ ok: true, exitCode: 0 })]);
    const r = await runCascade({
      ...baseOpts,
      cascade: ["codex"],
      perAttemptTimeoutMs: 0,
      registry: registry({ codex }),
    });
    expect(r.ok).toBe(true);
    expect(codex.runOpts()[0]?.timeoutMs).toBe(0);
  });

  it("records the resolved model on every attempt across a fall-through", async () => {
    const codex = mock("codex", [res({ timedOut: true })]);
    const claude = mock("claude", [res({ ok: true, exitCode: 0 })]);
    const r = await runCascade({
      ...baseOpts,
      cascade: [{ harness: "codex", model: "o3" }, { harness: "claude" }],
      registry: registry({ codex, claude }),
    });
    expect(r.attempts.map((a) => [a.harness, a.model, a.outcome])).toEqual([
      ["codex", "o3", "timeout"],
      ["claude", DEFAULT_MODEL.claude, "success"],
    ]);
  });

  it("reports failure for an EMPTY cascade instead of claiming success with no harness", async () => {
    // An empty step list means nothing ran. Returning ok:true here would let a
    // misconfigured cascade record a green run that never executed anything.
    const r = await runCascade({
      ...baseOpts,
      cascade: [],
      registry: registry(),
    });
    expect(r.ok).toBe(false);
    expect(r.harnessUsed).toBeNull();
    expect(r.attempts).toEqual([]);
  });

  it("records a step whose harness is missing from the registry, then cascades on", async () => {
    // A registry that does not carry the named harness must not throw — the step
    // is recorded as an attempt so the trail shows why it was skipped, and the
    // next step still gets its turn.
    const claude = mock("claude", [res({ ok: true, exitCode: 0 })]);
    const partial = { claude } as unknown as Parameters<
      typeof runCascade
    >[0]["registry"];
    const r = await runCascade({
      ...baseOpts,
      cascade: [{ harness: "codex" }, { harness: "claude" }],
      registry: partial,
    });
    expect(r.ok).toBe(true);
    expect(r.harnessUsed).toBe("claude");
    expect(r.attempts[0]?.harness).toBe("codex");
    expect(r.attempts[0]?.outcome).not.toBe("success");
  });
});

describe("cascadeStepSchema model half", () => {
  it("treats a trailing colon with no model as no model at all", () => {
    // `"claude:"` is a harness with an EMPTY model half. It must collapse to
    // "no model" (⇒ the harness's default) rather than pinning the model to the
    // empty string, which would reach the engine as `--model ""`.
    expect(cascadeStepSchema.parse("claude:")).toEqual({ harness: "claude" });
  });

  it("keeps a model that itself contains a colon", () => {
    expect(cascadeStepSchema.parse("claude:anthropic:opus")).toEqual({
      harness: "claude",
      model: "anthropic:opus",
    });
  });
});
