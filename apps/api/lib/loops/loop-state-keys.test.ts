/**
 * Coverage for the PURE key/isolation exports of `loop-state.ts`.
 *
 * That module is mostly S3-bound, so this suite deliberately covers only the
 * functions that need no client: the two prefix builders and
 * `validateKeyBelongsToLoop`, which is the multi-tenant isolation guard that
 * stops a loop runner reading another loop's — or another org's — state. PRD-618
 * puts security-critical paths at 90%, so it is exercised against traversal and
 * near-miss prefixes, not just the happy path.
 *
 * The S3 client is lazily constructed inside the functions that use it, so
 * importing this module does not open a connection.
 */

import { describe, expect, it } from "vitest";
import {
  getLoopPrefix,
  getStateKeyPrefix,
  validateKeyBelongsToLoop,
} from "./loop-state";

const ORG = "org-1";
const LOOP = "loop-1";

describe("getLoopPrefix", () => {
  it("builds the loop-wide prefix with a trailing slash", () => {
    // The trailing slash is what keeps a sweep over `loop-1/` from also
    // matching `loop-10/`.
    expect(getLoopPrefix(ORG, LOOP)).toBe("org-1/loops/loop-1/");
  });
});

describe("getStateKeyPrefix", () => {
  it("nests a run under the loop prefix", () => {
    expect(getStateKeyPrefix(ORG, LOOP, "run-1")).toBe(
      "org-1/loops/loop-1/run-1"
    );
  });

  it("generates a distinct run id when none is supplied", () => {
    const a = getStateKeyPrefix(ORG, LOOP);
    const b = getStateKeyPrefix(ORG, LOOP);

    expect(a).not.toBe(b);
    expect(a.startsWith(getLoopPrefix(ORG, LOOP))).toBe(true);
  });

  it("produces a key that its own loop prefix validates", () => {
    expect(
      validateKeyBelongsToLoop(
        `${getStateKeyPrefix(ORG, LOOP, "run-1")}/artifact.json`,
        ORG,
        LOOP
      )
    ).toBe(true);
  });
});

describe("validateKeyBelongsToLoop — multi-tenant isolation", () => {
  it("accepts a key under the loop's own prefix", () => {
    expect(
      validateKeyBelongsToLoop("org-1/loops/loop-1/run-1/state.json", ORG, LOOP)
    ).toBe(true);
  });

  it("rejects another loop in the same org", () => {
    expect(
      validateKeyBelongsToLoop("org-1/loops/loop-2/run-1/state.json", ORG, LOOP)
    ).toBe(false);
  });

  it("rejects another organization entirely", () => {
    expect(
      validateKeyBelongsToLoop("org-2/loops/loop-1/run-1/state.json", ORG, LOOP)
    ).toBe(false);
  });

  it("rejects a loop id that merely PREFIXES the real one", () => {
    // Without the trailing slash in the comparison, `loop-1` would match
    // `loop-10`, handing one loop another's state.
    expect(
      validateKeyBelongsToLoop("org-1/loops/loop-10/state.json", ORG, LOOP)
    ).toBe(false);
  });

  it("rejects parent traversal anywhere in the key", () => {
    expect(
      validateKeyBelongsToLoop("org-1/loops/loop-1/../loop-2/x", ORG, LOOP)
    ).toBe(false);
    expect(validateKeyBelongsToLoop("../org-2/loops/loop-1/x", ORG, LOOP)).toBe(
      false
    );
  });

  it("rejects a current-directory segment anywhere in the key", () => {
    expect(
      validateKeyBelongsToLoop("org-1/loops/loop-1/./state.json", ORG, LOOP)
    ).toBe(false);
  });

  it("rejects traversal even when the key otherwise starts with the right prefix", () => {
    // Prefix-match alone is not enough: the traversal check must run first.
    expect(
      validateKeyBelongsToLoop(
        "org-1/loops/loop-1/run/../../../org-2/secret",
        ORG,
        LOOP
      )
    ).toBe(false);
  });

  it("rejects an absolute or empty key", () => {
    expect(validateKeyBelongsToLoop("", ORG, LOOP)).toBe(false);
    expect(
      validateKeyBelongsToLoop("/org-1/loops/loop-1/state.json", ORG, LOOP)
    ).toBe(false);
  });

  it("is case-sensitive on the org and loop segments", () => {
    expect(
      validateKeyBelongsToLoop("ORG-1/loops/loop-1/state.json", ORG, LOOP)
    ).toBe(false);
  });
});
