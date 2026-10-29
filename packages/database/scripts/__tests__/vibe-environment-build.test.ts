import { describe, expect, it, vi } from "vitest";
import {
  type VibeEnvironmentMarker,
  VibeEnvironmentMode,
  VibeEnvironmentState,
} from "../vibe-environment";
import { ensureSchemaForBuild } from "../vibe-environment-build";

const URL = "postgres://x";
const SCHEMA = "preview_vibe_bulk_tags_1a2b3c4d";

function makeDeps(opts: {
  marker: VibeEnvironmentMarker | null;
  isNew: boolean;
}) {
  const steps: string[] = [];
  return {
    steps,
    deps: {
      readVibeEnvironmentMarker: vi.fn(() => {
        steps.push("read");
        return Promise.resolve(opts.marker);
      }),
      dropSchema: vi.fn(() => {
        steps.push("drop");
        return Promise.resolve();
      }),
      ensureSchemaExists: vi.fn(() => {
        steps.push("ensure");
        return Promise.resolve(opts.isNew);
      }),
      writeVibeEnvironmentMarker: vi.fn(
        (_url: string, _schema: string, marker: VibeEnvironmentMarker) => {
          steps.push(`mark:${marker.mode}:${marker.state}`);
          return Promise.resolve();
        }
      ),
    },
  };
}

describe("ensureSchemaForBuild without a vibe request (every normal deploy)", () => {
  it("ensures and reports an existing vibe marker, never dropping", async () => {
    const marker = {
      mode: VibeEnvironmentMode.Blank,
      state: VibeEnvironmentState.Ready,
    };
    const { deps, steps } = makeDeps({ marker, isNew: false });
    const built = await ensureSchemaForBuild(deps, URL, SCHEMA, undefined);
    expect(built).toEqual({
      isNew: false,
      vibeEnvironment: marker,
      rebuilt: false,
    });
    expect(steps).toEqual(["ensure", "read"]);
  });

  it("does not read a marker for public", async () => {
    const { deps, steps } = makeDeps({ marker: null, isNew: false });
    const built = await ensureSchemaForBuild(deps, URL, null, undefined);
    expect(built.vibeEnvironment).toBeNull();
    expect(steps).toEqual(["ensure"]);
  });
});

describe("ensureSchemaForBuild for a vibe environment dispatch", () => {
  it("drops a schema a normal deploy already cloned, then marks it before anything migrates", async () => {
    const { deps, steps } = makeDeps({ marker: null, isNew: true });
    const built = await ensureSchemaForBuild(
      deps,
      URL,
      SCHEMA,
      VibeEnvironmentMode.Seeded
    );
    expect(steps).toEqual(["read", "drop", "ensure", "mark:seeded:pending"]);
    expect(built).toEqual({
      isNew: true,
      rebuilt: true,
      vibeEnvironment: {
        mode: VibeEnvironmentMode.Seeded,
        state: VibeEnvironmentState.Pending,
      },
    });
  });

  it("keeps a ready schema of the same mode untouched", async () => {
    const marker = {
      mode: VibeEnvironmentMode.Blank,
      state: VibeEnvironmentState.Ready,
    };
    const { deps, steps } = makeDeps({ marker, isNew: false });
    const built = await ensureSchemaForBuild(
      deps,
      URL,
      SCHEMA,
      VibeEnvironmentMode.Blank
    );
    expect(steps).toEqual(["read", "ensure"]);
    expect(built).toEqual({
      isNew: false,
      vibeEnvironment: marker,
      rebuilt: false,
    });
  });

  it("rebuilds when the requested mode differs", async () => {
    const { deps, steps } = makeDeps({
      marker: {
        mode: VibeEnvironmentMode.Seeded,
        state: VibeEnvironmentState.Ready,
      },
      isNew: true,
    });
    await ensureSchemaForBuild(deps, URL, SCHEMA, VibeEnvironmentMode.Blank);
    expect(steps).toEqual(["read", "drop", "ensure", "mark:blank:ready"]);
  });

  it.each([
    ["public", null],
    ["an explicit non-preview schema", "explicit_schema"],
  ])("refuses %s before touching it", async (_label, schema) => {
    const { deps, steps } = makeDeps({ marker: null, isNew: false });
    await expect(
      ensureSchemaForBuild(deps, URL, schema, VibeEnvironmentMode.Blank)
    ).rejects.toThrow("only branch preview schemas");
    expect(steps).toEqual([]);
  });
});
