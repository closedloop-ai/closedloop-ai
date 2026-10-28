import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  formatVibeEnvironmentMarker,
  initialVibeEnvironmentMarker,
  parseVibeEnvironmentMarker,
  readVibeEnvironmentMarker,
  schemaOfVibeEnvironmentKey,
  VibeEnvironmentMode,
  VibeEnvironmentState,
  vibeEnvironmentKeyPrefix,
  vibeEnvironmentNeedsRebuild,
  writeVibeEnvironmentMarker,
} from "../vibe-environment";

const SCHEMA = "preview_vibe_bulk_tags_1a2b3c4d";
const SEEDED_READY = {
  mode: VibeEnvironmentMode.Seeded,
  state: VibeEnvironmentState.Ready,
};

function fakeClient(rows: { comment: string | null }[] = []) {
  const issued: { sql: string; params?: unknown[] }[] = [];
  const client = {
    connect: vi.fn(() => Promise.resolve()),
    end: vi.fn(() => Promise.resolve()),
    query: vi.fn((sql: string, params?: unknown[]) => {
      issued.push({ sql, params });
      return Promise.resolve({ rows });
    }),
  };
  return { client: client as unknown as pg.Client, issued, spies: client };
}

describe("parseVibeEnvironmentMarker", () => {
  it("round-trips what format writes", () => {
    expect(
      parseVibeEnvironmentMarker(formatVibeEnvironmentMarker(SEEDED_READY))
    ).toEqual(SEEDED_READY);
  });

  it.each([
    ["no comment", null],
    ["an empty comment", ""],
    ["a comment that is not JSON", "built by hand for a demo"],
    ["JSON that is not ours", '{"owner":"someone"}'],
    [
      "an unknown mode",
      '{"closedloopVibeEnvironment":{"mode":"cloned","state":"ready"}}',
    ],
    [
      "an unknown state",
      '{"closedloopVibeEnvironment":{"mode":"blank","state":"done"}}',
    ],
  ])("reads %s as no marker", (_label, comment) => {
    expect(parseVibeEnvironmentMarker(comment)).toBeNull();
  });
});

describe("vibeEnvironmentNeedsRebuild", () => {
  it("keeps a ready schema of the requested mode", () => {
    expect(
      vibeEnvironmentNeedsRebuild(SEEDED_READY, VibeEnvironmentMode.Seeded)
    ).toBe(false);
  });

  it("rebuilds an unmarked schema, which may hold a clone of public", () => {
    expect(vibeEnvironmentNeedsRebuild(null, VibeEnvironmentMode.Blank)).toBe(
      true
    );
  });

  it("rebuilds a schema of the other mode", () => {
    expect(
      vibeEnvironmentNeedsRebuild(SEEDED_READY, VibeEnvironmentMode.Blank)
    ).toBe(true);
  });

  it("rebuilds a seeded schema whose seed never finished", () => {
    expect(
      vibeEnvironmentNeedsRebuild(
        {
          mode: VibeEnvironmentMode.Seeded,
          state: VibeEnvironmentState.Pending,
        },
        VibeEnvironmentMode.Seeded
      )
    ).toBe(true);
  });
});

describe("initialVibeEnvironmentMarker", () => {
  it("starts a seeded schema pending its seed and a blank one ready", () => {
    expect(initialVibeEnvironmentMarker(VibeEnvironmentMode.Seeded)).toEqual({
      mode: VibeEnvironmentMode.Seeded,
      state: VibeEnvironmentState.Pending,
    });
    expect(initialVibeEnvironmentMarker(VibeEnvironmentMode.Blank)).toEqual({
      mode: VibeEnvironmentMode.Blank,
      state: VibeEnvironmentState.Ready,
    });
  });
});

describe("vibe environment key prefixes", () => {
  it("keys each schema under its own prefix", () => {
    expect(vibeEnvironmentKeyPrefix(SCHEMA)).toBe(
      `vibe-environments/${SCHEMA}/`
    );
    expect(vibeEnvironmentKeyPrefix("preview_other_9f8e7d6c")).not.toBe(
      vibeEnvironmentKeyPrefix(SCHEMA)
    );
  });

  it("refuses a schema that is not a preview", () => {
    expect(() => vibeEnvironmentKeyPrefix("public")).toThrow(
      "not a preview schema"
    );
  });

  it("maps a prefixed key back to its schema and nothing else", () => {
    expect(
      schemaOfVibeEnvironmentKey(`vibe-environments/${SCHEMA}/org/ct/s.jsonl`)
    ).toBe(SCHEMA);
    expect(schemaOfVibeEnvironmentKey(`vibe-environments/${SCHEMA}`)).toBe(
      SCHEMA
    );
    expect(schemaOfVibeEnvironmentKey("org/ct/s.jsonl")).toBeNull();
    expect(
      schemaOfVibeEnvironmentKey("vibe-environments/public/org/ct/s.jsonl")
    ).toBeNull();
  });
});

describe("readVibeEnvironmentMarker", () => {
  it("reads the schema comment by name", async () => {
    const { client, issued, spies } = fakeClient([
      { comment: formatVibeEnvironmentMarker(SEEDED_READY) },
    ]);
    const marker = await readVibeEnvironmentMarker("postgres://x", SCHEMA, {
      createClient: () => client,
    });
    expect(marker).toEqual(SEEDED_READY);
    expect(issued[0]?.params).toEqual([SCHEMA]);
    expect(spies.end).toHaveBeenCalledTimes(1);
  });

  it("answers null without connecting for public", async () => {
    const createClient = vi.fn();
    await expect(
      readVibeEnvironmentMarker("postgres://x", null, { createClient })
    ).resolves.toBeNull();
    await expect(
      readVibeEnvironmentMarker("postgres://x", "public", { createClient })
    ).resolves.toBeNull();
    expect(createClient).not.toHaveBeenCalled();
  });
});

describe("writeVibeEnvironmentMarker", () => {
  it("comments the schema with the marker", async () => {
    const { client, issued } = fakeClient();
    await writeVibeEnvironmentMarker("postgres://x", SCHEMA, SEEDED_READY, {
      createClient: () => client,
    });
    expect(issued[0]?.sql).toBe(
      `COMMENT ON SCHEMA "${SCHEMA}" IS '${formatVibeEnvironmentMarker(SEEDED_READY)}'`
    );
  });

  it("refuses public before connecting", async () => {
    const createClient = vi.fn();
    await expect(
      writeVibeEnvironmentMarker("postgres://x", "public", SEEDED_READY, {
        createClient,
      })
    ).rejects.toThrow("not a preview schema");
    expect(createClient).not.toHaveBeenCalled();
  });
});
