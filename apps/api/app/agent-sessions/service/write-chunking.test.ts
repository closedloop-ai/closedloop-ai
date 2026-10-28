import { describe, expect, it } from "vitest";
import {
  POSTGRES_MAX_ACCEPTED_BIND_PARAMETERS,
  POSTGRES_MAX_ACCEPTED_VERBATIM_BIND_PARAMETERS,
  POSTGRES_MAX_BIND_PARAMETERS,
  POSTGRES_MAX_VERBATIM_BIND_PARAMETERS,
} from "@/lib/postgres-bind-parameters";
import {
  ACTIVITY_SEGMENT_BIND_PARAMETERS_PER_ROW,
  ACTIVITY_SEGMENT_FIXED_BIND_PARAMETERS,
} from "./activity-segment-persistence";
import {
  bindParameterChunkSize,
  PRISMA_IMPLICIT_BIND_PARAMETERS,
} from "./write-chunking";

/**
 * ISS-8185: the bound itself, exercised against populations that actually cross
 * it.
 *
 * WHAT THESE ASSERTIONS COUNT, AND WHY IT CHANGED. The previous revision of this
 * suite asserted the emitted statement stayed `<= POSTGRES_MAX_BIND_PARAMETERS`
 * — and that expectation was wrong in the first place, which is why it stayed
 * green while `main` went red. 32,767 is the count at which a built statement is
 * REFUSED, not the widest one that runs, so a chunk sized to hit it exactly
 * satisfied the old assertion and was rejected by the driver. Measured against
 * PostgreSQL 16 (ISS-8185): a `deleteMany` is accepted at 32,766 and refused at
 * 32,767, a `findMany` is refused at 32,766 because it binds one parameter of
 * its own, and a `findMany` with a `take` is refused at 32,765 because it binds
 * two.
 *
 * So the invariant every case below asserts is the whole statement as the DRIVER
 * sees it — the caller's fixed binds, plus the slice, plus the binds Prisma adds
 * that no caller can count — landing at or under the largest count actually
 * accepted.
 *
 * THE HELPER CHARGES EVERY CALLER THE WIDEST OF THOSE OVERHEADS, so a "still
 * fits" assertion may model that widest kind and be sound for all of them, while
 * a claim that a slice is the LARGEST one that fits is true only of the kind the
 * reserve was sized for — see {@link MEASURED_IMPLICIT_BIND_PARAMETERS}, which
 * the maximality case names its kind from rather than inheriting the reserve.
 */
const WIDE_ROW_BIND_PARAMETERS = POSTGRES_MAX_BIND_PARAMETERS * 2;

/**
 * The statement the driver actually receives for a given chunk size, modelling
 * the WIDEST-overhead statement kind: what the caller modelled, plus the two
 * parameters the helper reserves on every caller's behalf. Sound for asserting a
 * slice fits, and not the model to make a maximality claim against.
 */
function statementBindParameters(
  chunkSize: number,
  bindParametersPerRow: number,
  fixedBindParameters: number
): number {
  return (
    chunkSize * bindParametersPerRow +
    fixedBindParameters +
    PRISMA_IMPLICIT_BIND_PARAMETERS
  );
}

/**
 * Row widths chosen to include the ones that DIVIDE the ceiling, because those
 * are exactly where the off-by-one hides: at a width that leaves no remainder,
 * a budget that is one too generous produces a chunk whose last row lands on the
 * refused count. A width the ceiling is not divisible by absorbs the error in
 * its remainder and stays green while the arithmetic is wrong.
 *
 * Every width here is one a real statement could carry. A row WIDER than the
 * whole budget cannot fit any statement by construction — the helper's
 * floor-at-1 escape hatch deliberately emits an over-wide statement rather than
 * looping on empty ones, and that case is asserted on its own below.
 */
const ADVERSARIAL_ROW_WIDTHS = [1, 2, 3, 7, 11, 13, 64] as const;
const ADVERSARIAL_FIXED_BINDS = [0, 1, 2, 6, 767] as const;

/**
 * What Prisma binds of its OWN, per statement kind, MEASURED in ISS-8185 by
 * driving each kind to its exact refusal point (Prisma 7.8 /
 * `@prisma/adapter-pg` / PostgreSQL 16).
 *
 * Literals rather than a derivation from {@link PRISMA_IMPLICIT_BIND_PARAMETERS}
 * on purpose, and the distinction is the point: that constant is the single
 * conservative RESERVE the helper charges every caller — the widest of these —
 * so a maximality claim written against it describes no statement in particular
 * AND cannot fail when the reserve itself drifts.
 */
const MEASURED_IMPLICIT_BIND_PARAMETERS = {
  deleteMany: 0,
  findMany: 1,
  findManyWithTake: 2,
} as const;

type PrismaStatementKind = keyof typeof MEASURED_IMPLICIT_BIND_PARAMETERS;

/** The statement one specific kind actually puts on the wire for a chunk size. */
function measuredStatementBindParameters(
  kind: PrismaStatementKind,
  chunkSize: number,
  bindParametersPerRow: number,
  fixedBindParameters: number
): number {
  return (
    chunkSize * bindParametersPerRow +
    fixedBindParameters +
    MEASURED_IMPLICIT_BIND_PARAMETERS[kind]
  );
}

describe("bindParameterChunkSize (ISS-8185)", () => {
  it("keeps every (row width, fixed bind) pair's whole statement inside what the driver accepts", () => {
    for (const bindParametersPerRow of ADVERSARIAL_ROW_WIDTHS) {
      for (const fixedBindParameters of ADVERSARIAL_FIXED_BINDS) {
        const chunkSize = bindParameterChunkSize(
          bindParametersPerRow,
          fixedBindParameters
        );

        expect({
          bindParametersPerRow,
          fixedBindParameters,
          fits:
            statementBindParameters(
              chunkSize,
              bindParametersPerRow,
              fixedBindParameters
            ) <= POSTGRES_MAX_ACCEPTED_BIND_PARAMETERS,
        }).toEqual({ bindParametersPerRow, fixedBindParameters, fits: true });
      }
    }
  });

  it("reserves the statement's fixed binds rather than sizing against the bare ceiling", () => {
    const fixedBindParameters = 2;

    const chunkSize = bindParameterChunkSize(1, fixedBindParameters);

    // Strictly smaller than the ceiling minus the caller's own binds: Prisma's
    // implicit binds come out of the same budget, and a slice that ignores them
    // is over the line by exactly them.
    expect(chunkSize).toBeLessThan(
      POSTGRES_MAX_BIND_PARAMETERS - fixedBindParameters
    );
    expect(
      statementBindParameters(chunkSize, 1, fixedBindParameters)
    ).toBeLessThanOrEqual(POSTGRES_MAX_ACCEPTED_BIND_PARAMETERS);
  });

  it("hands the kind its reserve is sized for the largest slice that fits, and the kinds that bind less a deliberately shorter one", () => {
    for (const bindParametersPerRow of ADVERSARIAL_ROW_WIDTHS) {
      const fixedBindParameters = 1;
      const chunkSize = bindParameterChunkSize(
        bindParametersPerRow,
        fixedBindParameters
      );

      // For a `findMany` with a `take` — the kind the reserve is measured
      // against — one more row crosses the line, so the loop does not multiply
      // round trips inside the caller's interactive transaction for nothing.
      expect(
        measuredStatementBindParameters(
          "findManyWithTake",
          chunkSize + 1,
          bindParametersPerRow,
          fixedBindParameters
        )
      ).toBeGreaterThan(POSTGRES_MAX_ACCEPTED_BIND_PARAMETERS);

      // A `deleteMany` binds nothing of its own and is charged the same reserve
      // anyway, so its statement stops STRICTLY short of what that kind accepts.
      // Pinned rather than implied: drop the reserve and this slice lands on the
      // wall for a one-parameter row.
      expect(
        measuredStatementBindParameters(
          "deleteMany",
          chunkSize,
          bindParametersPerRow,
          fixedBindParameters
        )
      ).toBeLessThan(POSTGRES_MAX_ACCEPTED_BIND_PARAMETERS);
    }
  });

  it("sizes the activity-segment insert under the count the driver accepts", () => {
    const chunkSize = bindParameterChunkSize(
      ACTIVITY_SEGMENT_BIND_PARAMETERS_PER_ROW,
      ACTIVITY_SEGMENT_FIXED_BIND_PARAMETERS
    );

    expect(
      statementBindParameters(
        chunkSize,
        ACTIVITY_SEGMENT_BIND_PARAMETERS_PER_ROW,
        ACTIVITY_SEGMENT_FIXED_BIND_PARAMETERS
      )
    ).toBeLessThanOrEqual(POSTGRES_MAX_ACCEPTED_BIND_PARAMETERS);
  });

  it("keeps the refused count and the accepted count one apart", () => {
    // The distinction the regression collapsed. If these ever converge, every
    // budget derived from the accepted count silently becomes the refused one.
    expect(POSTGRES_MAX_ACCEPTED_BIND_PARAMETERS).toBe(
      POSTGRES_MAX_BIND_PARAMETERS - 1
    );
  });

  it("gives the verbatim pair the same bound semantics as the built pair (ISS-8239)", () => {
    // whitlockk: the verbatim ceiling first shipped holding 65,535 while its name
    // and prose called it the refusal threshold, so the two pairs carried
    // OPPOSITE bound semantics under one naming shape and the next raw-query
    // chunker would inherit the ISS-8185 fencepost. `MAX_*` is the refused
    // count in BOTH pairs; `MAX_ACCEPTED_*` is the width a chunk may reach.
    expect(POSTGRES_MAX_VERBATIM_BIND_PARAMETERS).toBe(65_536);
    expect(POSTGRES_MAX_ACCEPTED_VERBATIM_BIND_PARAMETERS).toBe(
      POSTGRES_MAX_VERBATIM_BIND_PARAMETERS - 1
    );
    // …and the two ceilings stay distinct, so a consumer cannot satisfy one by
    // reserving against the other.
    expect(POSTGRES_MAX_VERBATIM_BIND_PARAMETERS).toBeGreaterThan(
      POSTGRES_MAX_BIND_PARAMETERS
    );
  });

  it("floors at one row so a pathologically wide row still makes progress", () => {
    expect(bindParameterChunkSize(WIDE_ROW_BIND_PARAMETERS, 0)).toBe(1);
  });
});
