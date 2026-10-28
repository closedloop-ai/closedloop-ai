import path from "node:path";
import { describe, expect, it, vi } from "vitest";

// ISS-7952. `setup.ts` is this app's Vitest setup file, and it loads
// `apps/api/.env.local` through dotenv. dotenv resolves a relative path against
// the PROCESS cwd — not against `root`, and not against the setup file — which
// is `apps/api` for every normal invocation but the REPO ROOT under
// `pnpm mutation`, because `apps/api` is a `ROOT_SANDBOX_PACKAGES` entry in
// scripts/mutation/run.mjs and Stryker is spawned from the repo root there.
//
// Left as the bare `".env.local"`, a repo-root run reads `<repo>/.env.local` —
// a different file, or none at all — so env-validated modules and env-gated
// branches take a different path than the same suite takes locally, and the
// mutation score is computed against that other behaviour.
//
// This asserts the resolved path is the app's own file, which is what makes it
// cwd-independent. It is asserted rather than reproduced by chdir because the
// unit lane runs on `pool: "threads"`, where `process.chdir` does not exist.

const dotenvConfig = vi.fn();

vi.mock("dotenv", () => ({ config: dotenvConfig }));

const EXPECTED_ENV_FILE = path.resolve(import.meta.dirname, "../.env.local");

describe("apps/api vitest setup env loading (ISS-7952)", () => {
  it("loads apps/api/.env.local by absolute path, so a repo-root cwd gets the same env", async () => {
    // `setup.ts` already ran once for this file as the lane's real setup file,
    // against the real dotenv. Reset so the re-import re-executes it and the
    // mock above observes the call.
    vi.resetModules();
    dotenvConfig.mockClear();

    await import("./setup.ts");

    expect(dotenvConfig).toHaveBeenCalledWith({ path: EXPECTED_ENV_FILE });
    expect(path.isAbsolute(EXPECTED_ENV_FILE)).toBe(true);
  });
});
