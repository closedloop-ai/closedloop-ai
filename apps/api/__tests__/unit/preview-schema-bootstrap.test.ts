import { normalizePreviewSchemaName } from "@repo/database/schema-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ISS-5984 — the lazy preview-schema bootstrap gate.
 *
 * These assert the PRODUCTION WIRING, not the unit: that the gate calls the
 * ensure service the `/preview-schemas/ensure` route calls (delete that call
 * site and the first test goes red), that `apps/api`'s Node instrumentation is
 * what installs the gate into `@repo/database`, that a concurrent second caller
 * does not spawn a second `prisma migrate deploy` against the same schema, and
 * that BOTH gate conditions default closed.
 *
 * Every case re-imports the gate through `vi.resetModules()` because the memo is
 * module-level per instance — which is the behavior under test, so it must not
 * leak between cases and there is no test-only reset hatch in production code.
 */

const { mockEnsureSchemaAtHead, mockSetSchemaBootstrapHook } = vi.hoisted(
  () => ({
    mockEnsureSchemaAtHead: vi.fn(),
    mockSetSchemaBootstrapHook: vi.fn(),
  })
);

vi.mock("@/app/preview-schemas/ensure/service", () => ({
  ensureSchemaAtHead: mockEnsureSchemaAtHead,
}));

vi.mock("@repo/database", () => ({
  setSchemaBootstrapHook: mockSetSchemaBootstrapHook,
  setPoolTelemetrySink: vi.fn(),
}));

const BRANCH = "feat/iss-5984-lazy-preview-bootstrap";
const EXPECTED_SCHEMA = normalizePreviewSchemaName(BRANCH);
// `NODE_ENV` is required by Next's `ProcessEnv` augmentation, so a fixture env
// has to carry it even though nothing here reads it.
const PREVIEW_ENV = {
  NODE_ENV: "test",
  VERCEL_ENV: "preview",
  PREVIEW_SCHEMA_BOOTSTRAP: "1",
  VERCEL_GIT_COMMIT_REF: BRANCH,
} as const satisfies NodeJS.ProcessEnv;

type BootstrapModule = typeof import("@/lib/preview-schema-bootstrap");

async function loadGate(): Promise<BootstrapModule> {
  vi.resetModules();
  return await import("@/lib/preview-schema-bootstrap");
}

function previewEnv(
  overrides: Partial<Record<string, string>> = {}
): NodeJS.ProcessEnv {
  return { ...PREVIEW_ENV, ...overrides };
}

describe("preview schema bootstrap gate", () => {
  beforeEach(() => {
    mockEnsureSchemaAtHead.mockReset();
    mockEnsureSchemaAtHead.mockResolvedValue({
      ok: true,
      branch: BRANCH,
      schema: EXPECTED_SCHEMA,
      invalidIndexes: null,
      schemaEngineBinary: "/var/task/engines/schema-engine-linux",
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("brings this deployment's schema to head through the ensure service", async () => {
    const { ensurePreviewSchemaBootstrap } = await loadGate();

    await ensurePreviewSchemaBootstrap(previewEnv());

    expect(mockEnsureSchemaAtHead).toHaveBeenCalledTimes(1);
    expect(mockEnsureSchemaAtHead).toHaveBeenCalledWith(
      BRANCH,
      EXPECTED_SCHEMA
    );
  });

  it("runs one bootstrap for two concurrent first requests", async () => {
    const { ensurePreviewSchemaBootstrap } = await loadGate();

    // Both calls are issued before either can settle, so the second arrives
    // while the first bootstrap is still in flight — the real shape of a burst
    // of first requests hitting one cold instance. Without the shared in-flight
    // memo this is two concurrent `prisma migrate deploy` spawns against the
    // same schema.
    await Promise.all([
      ensurePreviewSchemaBootstrap(previewEnv()),
      ensurePreviewSchemaBootstrap(previewEnv()),
    ]);

    expect(mockEnsureSchemaAtHead).toHaveBeenCalledTimes(1);
  });

  it("clears the memo after a failure so a later request retries", async () => {
    const { ensurePreviewSchemaBootstrap } = await loadGate();
    mockEnsureSchemaAtHead.mockResolvedValueOnce({
      ok: false,
      message: "schema engine binary not found",
    });

    await expect(ensurePreviewSchemaBootstrap(previewEnv())).rejects.toThrow(
      "schema engine binary not found"
    );
    await ensurePreviewSchemaBootstrap(previewEnv());

    expect(mockEnsureSchemaAtHead).toHaveBeenCalledTimes(2);
  });

  it("does not re-run after a success", async () => {
    const { ensurePreviewSchemaBootstrap } = await loadGate();

    await ensurePreviewSchemaBootstrap(previewEnv());
    await ensurePreviewSchemaBootstrap(previewEnv());

    expect(mockEnsureSchemaAtHead).toHaveBeenCalledTimes(1);
  });

  it("stays closed on a preview deployment until the toggle is set", async () => {
    const { ensurePreviewSchemaBootstrap, isPreviewSchemaBootstrapEnabled } =
      await loadGate();
    // Everything EXCEPT the toggle is exactly what a live preview deploy has,
    // so this fails the moment the gate starts defaulting on.
    const env = previewEnv();
    Reflect.deleteProperty(env, "PREVIEW_SCHEMA_BOOTSTRAP");

    expect(isPreviewSchemaBootstrapEnabled(env)).toBe(false);
    await ensurePreviewSchemaBootstrap(env);

    expect(mockEnsureSchemaAtHead).not.toHaveBeenCalled();
  });

  it("stays closed outside a preview deployment even with the toggle on", async () => {
    const { ensurePreviewSchemaBootstrap, isPreviewSchemaBootstrapEnabled } =
      await loadGate();

    for (const vercelEnv of ["production", "development"]) {
      const env = previewEnv({ VERCEL_ENV: vercelEnv });
      expect(isPreviewSchemaBootstrapEnabled(env)).toBe(false);
      await ensurePreviewSchemaBootstrap(env);
    }

    expect(mockEnsureSchemaAtHead).not.toHaveBeenCalled();
  });

  it("treats only explicit truthy tokens as enabled", async () => {
    const { isPreviewSchemaBootstrapEnabled } = await loadGate();

    for (const raw of ["1", "true", " TRUE ", "yes", "on"]) {
      expect(
        isPreviewSchemaBootstrapEnabled(
          previewEnv({ PREVIEW_SCHEMA_BOOTSTRAP: raw })
        )
      ).toBe(true);
    }
    for (const raw of ["", "0", "false", "off", "no", "enabled", "2"]) {
      expect(
        isPreviewSchemaBootstrapEnabled(
          previewEnv({ PREVIEW_SCHEMA_BOOTSTRAP: raw })
        )
      ).toBe(false);
    }
  });

  it("skips when the deployment carries no git ref to derive a schema from", async () => {
    const { ensurePreviewSchemaBootstrap } = await loadGate();
    const env = previewEnv();
    Reflect.deleteProperty(env, "VERCEL_GIT_COMMIT_REF");

    await ensurePreviewSchemaBootstrap(env);

    expect(mockEnsureSchemaAtHead).not.toHaveBeenCalled();
  });

  it("is installed into @repo/database by the API node instrumentation", async () => {
    vi.resetModules();
    const { registerNodeInstrumentation } = await import(
      "@/instrumentation.node"
    );

    await registerNodeInstrumentation();

    expect(mockSetSchemaBootstrapHook).toHaveBeenCalledTimes(1);
    const hook = mockSetSchemaBootstrapHook.mock.calls[0]?.[0] as
      | (() => Promise<void>)
      | undefined;
    expect(typeof hook).toBe("function");

    // The registered hook must be the gate itself, not an unrelated callable:
    // drive it with a live preview env and assert it reaches the ensure service.
    vi.stubEnv("VERCEL_ENV", PREVIEW_ENV.VERCEL_ENV);
    vi.stubEnv(
      "PREVIEW_SCHEMA_BOOTSTRAP",
      PREVIEW_ENV.PREVIEW_SCHEMA_BOOTSTRAP
    );
    vi.stubEnv("VERCEL_GIT_COMMIT_REF", BRANCH);
    await hook?.();
    vi.unstubAllEnvs();

    expect(mockEnsureSchemaAtHead).toHaveBeenCalledWith(
      BRANCH,
      EXPECTED_SCHEMA
    );
  });
});
