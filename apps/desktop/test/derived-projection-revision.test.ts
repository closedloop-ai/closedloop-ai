/**
 * @file derived-projection-revision.test.ts
 * @description ISS-8741 — the durable descriptor that distinguishes a
 * last-known-good derived projection from a candidate replacement, and stamps
 * each with the source revision it was derived at.
 *
 * The expectations here are LITERAL strings written independently of the
 * formatter: the descriptor is a persisted value compared by byte equality, so a
 * test that re-derived its expectation from the encoder would stay green through
 * an encoding change that silently invalidates every stamped row on disk.
 */
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  formatDerivedProjectionRevision,
  ProjectionTarget,
} from "../src/main/database/derived-projection-revision.js";

describe("ISS-8741 derived projection revision descriptor", () => {
  test("formats components as a sorted name=version list", () => {
    assert.equal(
      formatDerivedProjectionRevision([
        { name: "data", version: 95 },
        { name: "classifier", version: 16 },
        { name: "schema", version: 2 },
      ]),
      "classifier=16;data=95;schema=2"
    );
  });

  test("declaration order cannot make an unchanged projection look stale", () => {
    const forward = formatDerivedProjectionRevision([
      { name: "alpha", version: 1 },
      { name: "beta", version: 2 },
    ]);
    const reversed = formatDerivedProjectionRevision([
      { name: "beta", version: 2 },
      { name: "alpha", version: 1 },
    ]);
    assert.equal(forward, "alpha=1;beta=2");
    assert.equal(reversed, forward);
  });

  test("a component set that grows produces a different descriptor", () => {
    const before = formatDerivedProjectionRevision([
      { name: "data", version: 95 },
    ]);
    const after = formatDerivedProjectionRevision([
      { name: "data", version: 95 },
      { name: "extractor", version: 29 },
    ]);
    assert.equal(before, "data=95");
    assert.equal(after, "data=95;extractor=29");
    assert.notEqual(
      before,
      after,
      "adding a component must make an older stamp compare unequal"
    );
  });

  test("refuses to format an unusable component rather than repairing it", () => {
    assert.equal(formatDerivedProjectionRevision([]), null, "empty set");
    assert.equal(
      formatDerivedProjectionRevision([{ name: "data", version: -1 }]),
      null,
      "negative version"
    );
    assert.equal(
      formatDerivedProjectionRevision([{ name: "data", version: 1.5 }]),
      null,
      "non-integer version"
    );
    assert.equal(
      formatDerivedProjectionRevision([{ name: "data", version: Number.NaN }]),
      null,
      "NaN version"
    );
    assert.equal(
      formatDerivedProjectionRevision([
        { name: "data", version: Number.POSITIVE_INFINITY },
      ]),
      null,
      "infinite version"
    );
    assert.equal(
      formatDerivedProjectionRevision([{ name: "data", version: 2_000_000 }]),
      null,
      "version above the accepted ceiling"
    );
    assert.equal(
      formatDerivedProjectionRevision([{ name: "da=ta", version: 1 }]),
      null,
      "a name carrying the encoding's own separator"
    );
    assert.equal(
      formatDerivedProjectionRevision([{ name: "da;ta", version: 1 }]),
      null,
      "a name carrying the component separator"
    );
    assert.equal(
      formatDerivedProjectionRevision([
        { name: "data", version: 1 },
        { name: "data", version: 2 },
      ]),
      null,
      "duplicate component names"
    );
  });

  test("names every projection a bad replacement can destroy", () => {
    assert.deepEqual(Object.values(ProjectionTarget).sort(), [
      "aggregate",
      "branches",
      "owner",
      "sessions",
    ]);
  });
});
