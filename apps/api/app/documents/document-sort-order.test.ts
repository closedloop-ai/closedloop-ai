/**
 * ISS-8728 — the move endpoint's optional concurrency precondition.
 *
 * `checkExpectedOrder` is pure, so these cases drive it directly rather than
 * through a transaction. The wiring that makes it load-bearing — that
 * `moveArtifact` consults it INSIDE `withDb.tx`, before it reads anything else
 * off the observed ordering — is asserted by the service's own integration
 * suite; a pure test cannot prove where a helper is called from.
 */
import {
  MOVE_ARTIFACT_CONFLICT,
  MOVE_ARTIFACT_EXPECTED_ORDER_LIMIT,
  MovePosition,
} from "@repo/api/src/types/project-artifact-move";
import { Status } from "@repo/api/src/types/result";
import { describe, expect, it } from "vitest";
import { checkExpectedOrder, resolveInsertIndex } from "./document-sort-order";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";

describe("checkExpectedOrder", () => {
  it("passes when no precondition was supplied (the shipped contract)", () => {
    // The compatibility branch: every caller that predates ISS-8728 — drag-drop,
    // keyboard move, the row menu, MCP agents, an older deployed bundle — sends
    // nothing here and must keep the last-write-wins behavior.
    expect(checkExpectedOrder([A, B, C], undefined).ok).toBe(true);
  });

  it("passes when the caller's ordering matches what the transaction observed", () => {
    expect(checkExpectedOrder([A, B, C], [A, B, C]).ok).toBe(true);
  });

  it("refuses a set that matches but whose ORDER moved", () => {
    // The whole point: a concurrent reorder leaves the set identical. A set
    // comparison would pass this, overwrite the other writer's edit, and report
    // success — which is the defect the precondition exists to make impossible.
    const result = checkExpectedOrder([A, C, B], [A, B, C]);

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected a conflict");
    }
    expect(result.error.status).toBe(Status.Conflict);
    expect(result.error.message).toContain(MOVE_ARTIFACT_CONFLICT);
  });

  it("refuses when a root was added under the caller", () => {
    expect(checkExpectedOrder([A, B, C], [A, B]).ok).toBe(false);
  });

  it("refuses when a root was removed under the caller", () => {
    expect(checkExpectedOrder([A, B], [A, B, C]).ok).toBe(false);
  });

  it("passes an empty project against an empty precondition", () => {
    // Degenerate but reachable: a caller that read an empty project and is
    // racing the first insert. Equal lengths and no entries to disagree about.
    expect(checkExpectedOrder([], []).ok).toBe(true);
  });

  it("refuses an empty precondition against a populated project", () => {
    expect(checkExpectedOrder([A], []).ok).toBe(false);
  });

  it("keeps the conflict independent of where the move was headed", () => {
    // `resolveInsertIndex` would happily place this move; the precondition is
    // what stops it. Pinned together so a future refactor cannot make the
    // ordering check conditional on the position.
    expect(
      resolveInsertIndex(
        [A, B, C],
        { artifactId: C, position: MovePosition.Top },
        "p"
      ).ok
    ).toBe(true);
    expect(checkExpectedOrder([A, C, B], [A, B, C]).ok).toBe(false);
  });

  it("reports the cap as a number the validator and this test share", () => {
    // The bound lives in the shared contract module; a second literal here is
    // how the validator and its test drift into disagreeing about it.
    expect(MOVE_ARTIFACT_EXPECTED_ORDER_LIMIT).toBeGreaterThan(0);
  });
});

describe("resolveInsertIndex", () => {
  const D = "44444444-4444-4444-8444-444444444444";

  it("returns the length of the remaining ordering for Bottom", () => {
    const result = resolveInsertIndex(
      [A, B, C],
      { artifactId: A, position: MovePosition.Bottom },
      "p"
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toBe(2);
  });

  it("requires a referenceArtifactId for Before/After", () => {
    const result = resolveInsertIndex(
      [A, B, C],
      { artifactId: A, position: MovePosition.Before },
      "p"
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.status).toBe(Status.BadRequest);
      expect(result.error.message).toContain("referenceArtifactId");
    }
  });

  it("rejects a referenceArtifactId equal to the artifact being moved", () => {
    const result = resolveInsertIndex(
      [A, B, C],
      { artifactId: A, position: MovePosition.After, referenceArtifactId: A },
      "p"
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.status).toBe(Status.BadRequest);
      expect(result.error.message).toContain("must differ");
    }
  });

  it("rejects a referenceArtifactId not present in the project's ordering", () => {
    const result = resolveInsertIndex(
      [A, B, C],
      { artifactId: A, position: MovePosition.Before, referenceArtifactId: D },
      "p"
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.status).toBe(Status.NotFound);
      expect(result.error.message).toContain(D);
    }
  });

  it("places the artifact at the reference's own index for Before", () => {
    // WITH the moved artifact (A) spliced out, `withoutTarget` is [B, C], so
    // B sits at index 0 — exactly where the moved artifact should land to
    // end up immediately before it.
    const result = resolveInsertIndex(
      [A, B, C],
      { artifactId: A, position: MovePosition.Before, referenceArtifactId: B },
      "p"
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toBe(0);
  });

  it("places the artifact one past the reference's index for After", () => {
    const result = resolveInsertIndex(
      [A, B, C],
      { artifactId: A, position: MovePosition.After, referenceArtifactId: B },
      "p"
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toBe(1);
  });
});
