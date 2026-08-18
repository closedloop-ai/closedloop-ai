import { describe, expect, it } from "vitest";
import { scheduledTaskSchema } from "../src/model.js";
import { createStubRoutineRegistrar } from "../src/scheduler/routine-registrar.js";

const NOT_WIRED_RE = /not wired/i;
const REGISTER_RE = /register/;
const TASK_NAME_RE = /nightly review/;
const DEREGISTER_RE = /deregister/;

/**
 * FEA-3816 (PRD-553 M4): the stub routine registrar is the honest default seam
 * injected by the desktop db host until a real cloud-routine API exists. Its
 * contract is best-effort: both verbs must RESOLVE (never reject) so a store
 * flip can never be wedged, report `ok:false` with a clear "not wired" note, and
 * record the intent through the optional log sink.
 */

function makeTask() {
  return scheduledTaskSchema.parse({
    id: "task-1",
    name: "nightly review",
    cron: "0 9 * * *",
    route: "claude-routine",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  });
}

describe("createStubRoutineRegistrar", () => {
  it("resolves register with ok:false and a not-wired note, logging the intent", async () => {
    const logs: string[] = [];
    const registrar = createStubRoutineRegistrar((message) =>
      logs.push(message)
    );

    const result = await registrar.register(makeTask());

    expect(result.ok).toBe(false);
    expect(result.routineId).toBe(null);
    expect(result.note).toMatch(NOT_WIRED_RE);
    // The intent is recorded through the log sink for diagnostics.
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(REGISTER_RE);
    expect(logs[0]).toMatch(TASK_NAME_RE);
  });

  it("resolves deregister with ok:false and a not-wired note", async () => {
    const logs: string[] = [];
    const registrar = createStubRoutineRegistrar((message) =>
      logs.push(message)
    );

    const result = await registrar.deregister(makeTask());

    expect(result.ok).toBe(false);
    expect(result.routineId).toBe(null);
    expect(result.note).toMatch(NOT_WIRED_RE);
    expect(logs[0]).toMatch(DEREGISTER_RE);
  });

  it("never throws when no log sink is provided", async () => {
    const registrar = createStubRoutineRegistrar();
    // Both verbs resolve (never reject) even with the default no-op log.
    await expect(registrar.register(makeTask())).resolves.toMatchObject({
      ok: false,
    });
    await expect(registrar.deregister(makeTask())).resolves.toMatchObject({
      ok: false,
    });
  });
});
