import { expect, it, vi } from "vitest";
import { bootstrapAgentDashboardRuntime } from "../src/main/dashboard/agent-dashboard-runtime-bootstrap.js";
import type { AgentDashboardDesignSystemRuntimeOptions } from "../src/main/dashboard/agent-dashboard-runtime-options.js";
import { bootstrapDeps } from "./agent-dashboard-bootstrap-fixture.js";

const createRuntime = vi.hoisted(() => vi.fn());
vi.mock(
  "../src/main/dashboard/agent-dashboard-design-system-runtime.js",
  () => ({
    createAgentDashboardDesignSystemRuntime: createRuntime,
  })
);
vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/session-mesh-bootstrap" },
}));

it("wires the real Desktop bootstrap to the native Mesh hook sink", async () => {
  createRuntime.mockResolvedValue({ opened: true });
  const deps = bootstrapDeps();
  const sink = vi.fn(async () => ({ additionalContext: "shared result" }));
  deps.onSessionMeshHookEvent = sink;
  const ready = vi.fn();
  deps.onSessionMeshReady = ready;
  expect(await bootstrapAgentDashboardRuntime(deps)).toMatchObject({
    ok: true,
  });
  const options = createRuntime.mock
    .calls[0]?.[0] as AgentDashboardDesignSystemRuntimeOptions;
  const event = {
    harness: "codex" as const,
    hookType: "UserPromptSubmit",
    data: { session_id: "native-id" },
  };
  expect(await options.onSessionMeshHookEvent?.(event)).toEqual({
    additionalContext: "shared result",
  });
  expect(sink).toHaveBeenCalledWith(event);
  expect(ready).not.toHaveBeenCalled();
  options.onSessionMeshReady?.();
  expect(ready).toHaveBeenCalledTimes(1);
});
