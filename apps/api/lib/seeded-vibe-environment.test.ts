import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
  withDb: vi.fn(() => {
    throw new Error("the default reader must not run in these tests");
  }),
  Prisma: { sql: vi.fn() },
}));

import { normalizePreviewSchemaName } from "@repo/database/schema-utils";
import {
  formatVibeEnvironmentMarker,
  VibeEnvironmentMode,
  VibeEnvironmentState,
} from "@repo/database/scripts/vibe-environment";
import { isSeededVibeEnvironmentRuntime } from "./seeded-vibe-environment";

/**
 * ISS-12135: the seeded-preview check behind the Members roster. Only the
 * marker the vibe workflow writes on the runtime's preview schema decides it,
 * and only a preview runtime reads the database.
 */

const BRANCH = "andy/acme-members";
const SCHEMA = normalizePreviewSchemaName(BRANCH);
const PREVIEW_ENV = { VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: BRANCH };

function marker(mode: VibeEnvironmentMode, state: VibeEnvironmentState) {
  return formatVibeEnvironmentMarker({ mode, state });
}

describe("isSeededVibeEnvironmentRuntime", () => {
  it.each([
    ["ready", VibeEnvironmentState.Ready],
    ["pending", VibeEnvironmentState.Pending],
  ])("is true on a seeded vibe preview (%s)", async (_name, state) => {
    const read = vi.fn(() =>
      Promise.resolve(marker(VibeEnvironmentMode.Seeded, state))
    );

    await expect(
      isSeededVibeEnvironmentRuntime(PREVIEW_ENV, read)
    ).resolves.toBe(true);
    expect(read).toHaveBeenCalledWith(SCHEMA);
  });

  it("is false on a blank vibe preview", async () => {
    const read = vi.fn(() =>
      Promise.resolve(
        marker(VibeEnvironmentMode.Blank, VibeEnvironmentState.Ready)
      )
    );

    await expect(
      isSeededVibeEnvironmentRuntime(PREVIEW_ENV, read)
    ).resolves.toBe(false);
  });

  it.each([
    ["no comment", null],
    ["a comment that is not the marker", "cloned from stage"],
    ["a malformed marker", '{"closedloopVibeEnvironment":{"mode":"cloned"}}'],
  ])("is false on a preview whose schema has %s", async (_name, comment) => {
    const read = vi.fn(() => Promise.resolve(comment));

    await expect(
      isSeededVibeEnvironmentRuntime(PREVIEW_ENV, read)
    ).resolves.toBe(false);
  });

  it.each([
    ["production", { VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "main" }],
    ["stage (no schema)", {}],
    ["an explicit non-preview schema", { PGSCHEMA: "public" }],
  ])("is false on %s without reading the database", async (_name, env) => {
    const read = vi.fn(() =>
      Promise.resolve(
        marker(VibeEnvironmentMode.Seeded, VibeEnvironmentState.Ready)
      )
    );

    await expect(isSeededVibeEnvironmentRuntime(env, read)).resolves.toBe(
      false
    );
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects when the marker cannot be read, rather than answering false", async () => {
    const read = vi.fn(() => Promise.reject(new Error("catalog unreachable")));

    await expect(
      isSeededVibeEnvironmentRuntime(PREVIEW_ENV, read)
    ).rejects.toThrow("catalog unreachable");
  });
});
