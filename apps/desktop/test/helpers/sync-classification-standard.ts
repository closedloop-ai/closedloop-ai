/**
 * @file sync-classification-standard.ts
 * @description The shared vocabulary and the generic guards for PRD-699
 * Appendix A conformance suites. Extracted from
 * `sync-classification-standard-conformance.test.ts` (ISS-8608) when the S3
 * presigned-PUT arm needed the same machinery and that file had ~116 logical
 * lines of headroom against the 1,000-line ceiling.
 *
 * WHAT MOVED IS THE MACHINERY, NEVER THE ORACLE. The `standard` column of every
 * cell stays a hand-written literal in the lane's own file, transcribed from
 * Appendix A rather than derived from anything under test — that duplication IS
 * the test, and centralizing it would let a table computed from the
 * implementation stay green while the standard was emptied. Only the types and
 * the assertions live here.
 *
 * EVERYTHING HERE IS A FUNCTION, deliberately. Registering `test()` blocks at
 * module scope would double-register the whole suite in every importing file;
 * the guards take the lanes they police as a parameter instead.
 */
import assert from "node:assert/strict";
import { test } from "vitest";

/**
 * Appendix A's three behavior classes, hand-transcribed.
 *
 * A shared module DOES own them now — `shared/sync-failure-classification.ts`,
 * which all five lanes read (ISS-8614) — and this is STILL the independent copy
 * those lanes are held to, exactly as this file's first version said it would
 * have to be. Importing the module's vocabulary here would make one wrong
 * definition move the lanes and the oracle together, which is the whole failure
 * this duplication exists to catch.
 *
 * The duplication is not left unguarded: `sync-failure-classification.test.ts`
 * asserts this copy still agrees with the module's, so a rename is a loud red
 * rather than a silent shared move.
 */
export const StandardClass = {
  Environmental: "ENVIRONMENTAL",
  Item: "ITEM",
  ProtocolAbsent: "PROTOCOL-ABSENT",
} as const;
export type StandardClass = (typeof StandardClass)[keyof typeof StandardClass];

/** A recorded non-conformance. The ledger is shrink-only. */
export type Divergence = {
  /** The class the lane's dispatch produces today. */
  readonly observed: StandardClass;
  /**
   * Where the gap is tracked: an ISS/PRD entry that owns the fix, or — when the
   * divergence costs nothing recoverable and earns no ticket — the reason it
   * has none, said out loud. Never blank, and never a bare "untracked": a
   * divergence nobody has either ticketed or excused is a bug in this ledger.
   */
  readonly owner: string;
};

/** One cell of a lane's conformance table. */
export type Cell = {
  /** Injected HTTP status. */
  readonly status: number;
  /** Machine-readable error code in the body, where the route sends one. */
  readonly code?: string;
  /** Human label used in the failure message. */
  readonly label: string;
  /** The class Appendix A assigns. Hand-transcribed; see the file header. */
  readonly standard: StandardClass;
  /**
   * Marks a cell whose status this build has never seen, so it exercises the
   * lane's HARDWIRED unknown default rather than a mapped branch. Structural on
   * purpose: selecting these by label prefix meant a reword silently dropped a
   * cell while the "at least one" guard still passed on the survivors.
   */
  readonly coversUnknownDefault?: true;
  readonly divergence?: Divergence;
};

/**
 * What one injected failure produced. `defect` carries anything that makes
 * `class` untrustworthy — the observers do no asserting themselves, so a drive
 * that went wrong is reported to the test body rather than passing silently.
 */
export type Observation = {
  readonly class: StandardClass;
  readonly defect: string | null;
};

/**
 * A lane and how to drive it. Generic over the cell so a lane whose fixtures
 * need a field the shared {@link Cell} has no business carrying — a raw response
 * body, say — can extend it without widening the type every other lane uses.
 */
export type Lane<C extends Cell = Cell> = {
  readonly name: string;
  readonly cells: readonly C[];
  readonly observe: (cell: C) => Promise<Observation> | Observation;
};

function expectedClassFor(cell: Cell): StandardClass {
  return cell.divergence?.observed ?? cell.standard;
}

/**
 * The four guards every conformance lane is held to. Call once per suite with
 * the lanes that suite owns.
 */
export function registerLaneConformanceGuards<C extends Cell>(
  lanes: readonly Lane<C>[]
): void {
  for (const lane of lanes) {
    test(`${lane.name}: every injected failure lands in the class the standard names`, async () => {
      for (const cell of lane.cells) {
        const observed = await lane.observe(cell);
        assert.equal(
          observed.defect,
          null,
          `${lane.name} / ${cell.label}: the drive did not reach a verdict`
        );
        const because = cell.divergence
          ? `RECORDED DIVERGENCE (${cell.divergence.owner}) — if this now matches the standard (${cell.standard}), DELETE the divergence entry rather than editing it`
          : `Appendix A assigns ${cell.standard}`;
        assert.equal(
          observed.class,
          expectedClassFor(cell),
          `${lane.name} / ${cell.label}: ${because}`
        );
      }
    });

    test(`${lane.name}: an unrecognized status is classified by the hardwired default`, async () => {
      // Stated per lane because each lane has its own fallthrough, and named
      // separately from the table above so the acceptance criterion is findable.
      const cells = lane.cells.filter(
        (cell) => cell.coversUnknownDefault === true
      );
      assert.ok(
        cells.length > 0,
        `${lane.name} has no unrecognized-status cell, so the standard's hardwired default is unproven for it`
      );
      for (const cell of cells) {
        const observed = await lane.observe(cell);
        assert.equal(observed.defect, null, `${lane.name} / ${cell.label}`);
        assert.equal(
          observed.class,
          expectedClassFor(cell),
          `${lane.name} / ${cell.label}: a status this build has never seen must not be guessed as the item's fault`
        );
      }
    });
  }

  test("every lane's dispatch actually produces at least two classes", async () => {
    // The positive sibling of the per-cell assertions, and what makes "deleting
    // a lane's policy consultation fails the suite" true rather than merely
    // asserted: the set is built from what the OBSERVATIONS returned, never from
    // the caller's own expected literals. A dispatch that collapsed to one
    // verdict — or a table quietly reduced to one class — fails here.
    for (const lane of lanes) {
      const observed = new Set<StandardClass>();
      for (const cell of lane.cells) {
        observed.add((await lane.observe(cell)).class);
      }
      assert.ok(
        observed.size >= 2,
        `${lane.name}: every injected failure produced ${[...observed][0]}, so a dispatch that consulted no policy at all would still pass`
      );
    }
  });

  test("every recorded divergence differs from the standard and names an owner", () => {
    // Stops a no-op ledger entry — one recording the standard's own class —
    // from looking like tracked debt, and stops an anonymous one from hiding.
    for (const lane of lanes) {
      for (const cell of lane.cells) {
        if (!cell.divergence) {
          continue;
        }
        assert.notEqual(
          cell.divergence.observed,
          cell.standard,
          `${lane.name} / ${cell.label}: a divergence recording the standard's own class is not a divergence`
        );
        assert.ok(
          cell.divergence.owner.length > 20,
          `${lane.name} / ${cell.label}: a divergence must say where it is tracked`
        );
      }
    }
  });
}
