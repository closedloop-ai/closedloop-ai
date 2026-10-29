/**
 * ISS-7536. Prisma reports the violated unique constraint in one of two
 * mutually exclusive places, and which one depends on the driver. These tests
 * pin both, and pin the gap between them: on `@prisma/adapter-pg` 7.8 —
 * the adapter this app runs on — `meta.target` is absent entirely, so a caller
 * that consults only `getPrismaP2002Target` silently stops recognizing its own
 * constraint and re-throws a conflict it was supposed to map.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ logWarn: vi.fn() }));

vi.mock("@repo/observability/log", () => ({
  log: { warn: mocks.logWarn, error: vi.fn(), info: vi.fn() },
}));

import {
  getPrismaP2002ConstraintTarget,
  getPrismaP2002Target,
  matchesPrismaP2002Target,
} from "@/lib/db-utils";

const UNIQUE_INDEX_NAME = "artifact_links_source_id_target_id_link_type_key";
const CONSTRAINT_COLUMNS = ["source_id", "target_id", "link_type"];

/**
 * A real duplicate insert captured from
 * `__tests__/integration/artifact-links.test.ts` against local Postgres — the
 * COLUMN-LIST form of the adapter's constraint payload.
 *
 * ISS-8804: note which form this is. The realdb pin on the currently installed
 * Prisma (`__tests__/integration/p2002-adapter-payload-realdb.test.ts`) captures
 * the INDEX-NAME form (`constraint: { index: "organizations_slug_key" }`).
 * Both are accepted by `getPrismaP2002ConstraintTarget` and both are exercised
 * here on purpose, but only the index-name form is currently pinned against a
 * live database, so do not read this fixture as evidence of what 7.10 emits.
 */
function realAdapterP2002(): Error {
  return Object.assign(new Error("Unique constraint failed"), {
    code: "P2002",
    meta: {
      modelName: "ArtifactLink",
      driverAdapterError: {
        name: "DriverAdapterError",
        message: "UniqueConstraintViolation",
        cause: {
          originalCode: "23505",
          originalMessage: `duplicate key value violates unique constraint "${UNIQUE_INDEX_NAME}"`,
          kind: "UniqueConstraintViolation",
          constraint: { fields: CONSTRAINT_COLUMNS },
        },
      },
    },
  });
}

describe("getPrismaP2002ConstraintTarget", () => {
  it("reads the column list the pg driver adapter reports", () => {
    expect(getPrismaP2002ConstraintTarget(realAdapterP2002())).toEqual(
      CONSTRAINT_COLUMNS
    );
  });

  it("reads the index name for adapters that report one instead of columns", () => {
    const error = Object.assign(new Error("Unique constraint failed"), {
      code: "P2002",
      meta: {
        driverAdapterError: {
          cause: { constraint: { index: UNIQUE_INDEX_NAME } },
        },
      },
    });

    expect(getPrismaP2002ConstraintTarget(error)).toBe(UNIQUE_INDEX_NAME);
  });

  it("returns undefined for the documented meta.target shape it does not own", () => {
    const error = Object.assign(new Error("Unique constraint failed"), {
      code: "P2002",
      meta: { target: CONSTRAINT_COLUMNS },
    });

    expect(getPrismaP2002ConstraintTarget(error)).toBeUndefined();
  });

  it("returns undefined for a non-P2002 error", () => {
    const error = Object.assign(new Error("FK violation"), { code: "P2003" });

    expect(getPrismaP2002ConstraintTarget(error)).toBeUndefined();
  });
});

describe("getPrismaP2002Target — the gap this pair closes", () => {
  it("still reads the documented meta.target shape", () => {
    const error = Object.assign(new Error("Unique constraint failed"), {
      code: "P2002",
      meta: { target: CONSTRAINT_COLUMNS },
    });

    expect(getPrismaP2002Target(error)).toEqual(CONSTRAINT_COLUMNS);
  });

  it("finds nothing on a real pg-adapter P2002, which carries no meta.target", () => {
    // Not a defect in the extractor — it is why callers must consult both.
    expect(getPrismaP2002Target(realAdapterP2002())).toBeUndefined();
  });
});

/** The other shape: an adapter that reports an index NAME, not a column list. */
function adapterP2002WithIndexName(indexName: string): Error {
  return Object.assign(new Error("Unique constraint failed"), {
    code: "P2002",
    meta: {
      driverAdapterError: {
        name: "DriverAdapterError",
        cause: {
          originalCode: "23505",
          kind: "UniqueConstraintViolation",
          constraint: { index: indexName },
        },
      },
    },
  });
}

/** The legacy shape: `meta.target`, which adapter-pg never populates. */
function legacyP2002(target: unknown): Error {
  return Object.assign(new Error("Unique constraint failed"), {
    code: "P2002",
    meta: { target },
  });
}

describe("matchesPrismaP2002Target", () => {
  it("matches through meta.target when that is the populated shape", () => {
    const matched = matchesPrismaP2002Target(
      legacyP2002(["slug"]),
      (target) => Array.isArray(target) && target.includes("slug")
    );

    expect(matched).toBe(true);
  });

  it("matches through driverAdapterError when meta.target is unset", () => {
    // This is the case every caller was getting wrong: on adapter-pg only this
    // shape arrives, so a caller reading the other extractor alone never fires.
    const matched = matchesPrismaP2002Target(
      adapterP2002WithIndexName("organizations_slug_key"),
      (target) => target === "organizations_slug_key"
    );

    expect(matched).toBe(true);
  });

  it("returns false for a P2002 whose constraint the matcher does not claim", () => {
    const matched = matchesPrismaP2002Target(
      adapterP2002WithIndexName("organizations_clerk_id_key"),
      (target) => target === "organizations_slug_key"
    );

    expect(matched).toBe(false);
  });

  it("returns false for an error that is not a P2002 at all", () => {
    const notP2002 = Object.assign(new Error("nope"), { code: "P2003" });

    expect(matchesPrismaP2002Target(notP2002, () => true)).toBe(false);
  });

  it("never calls the matcher with the absent shape", () => {
    // A matcher written as a negation would otherwise return true for every
    // real adapter-pg P2002 and swallow unrelated unique violations as its own.
    const seen: unknown[] = [];

    matchesPrismaP2002Target(
      adapterP2002WithIndexName("organizations_slug_key"),
      (target) => {
        seen.push(target);
        return false;
      }
    );

    expect(seen).toEqual(["organizations_slug_key"]);
    expect(seen).not.toContain(undefined);
  });

  describe("the unrecognized-envelope alarm", () => {
    beforeEach(() => {
      mocks.logWarn.mockClear();
    });

    it("warns when a P2002 carries neither shape", () => {
      // The silence this replaces is how the branches died: a matcher that is
      // never called and a matcher that returns false look identical from the
      // outside, so every previous envelope move (ISS-7536, ISS-8556, ISS-8804)
      // killed N branches with the suite still green.
      const neitherShape = Object.assign(
        new Error("Unique constraint failed"),
        {
          code: "P2002",
          meta: { something: "prisma has not shipped this yet" },
        }
      );

      expect(matchesPrismaP2002Target(neitherShape, () => true)).toBe(false);
      expect(mocks.logWarn).toHaveBeenCalledTimes(1);
    });

    it("logs meta KEYS only, never a constraint name or column list", () => {
      // A constraint name or column list in a log line is a schema detail in an
      // aggregator. The shape is copied from loops/service.ts for that reason.
      const neitherShape = Object.assign(
        new Error("Unique constraint failed"),
        {
          code: "P2002",
          meta: { target: null },
        }
      );

      matchesPrismaP2002Target(neitherShape, () => true);

      const [, payload] = mocks.logWarn.mock.calls[0] ?? [];
      expect(JSON.stringify(payload)).not.toContain("organizations_slug_key");
      expect(payload).toEqual({
        code: "P2002",
        meta: { targetType: "absent", constraintPresent: false },
      });
    });

    it("stays SILENT on a recognized envelope, so the alarm means something", () => {
      matchesPrismaP2002Target(
        adapterP2002WithIndexName("organizations_slug_key"),
        () => false
      );

      expect(mocks.logWarn).not.toHaveBeenCalled();
    });

    it("stays silent on a non-P2002 error", () => {
      const notP2002 = Object.assign(new Error("nope"), { code: "P2025" });

      matchesPrismaP2002Target(notP2002, () => true);

      expect(mocks.logWarn).not.toHaveBeenCalled();
    });
  });
});
