import {
  DISPLAYED_SESSION_STATUS,
  SESSION_STATUS,
} from "@repo/api/src/types/session-status";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  compareByDisplayDuration,
  compareByDisplayedStatus,
  compareByOwnerDisplayName,
  compareByRecordUpdatedAt,
  type DisplaySortCandidate,
  resolveDisplayDurationMs,
  resolveOwnerSortKey,
  resolveRecordUpdatedAt,
} from "./session-display-sort";

const START = new Date("2026-05-20T17:00:00.000Z");
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/**
 * ISS-5131 (#4409 review): `resolveDisplayDurationMs` takes its clock as an
 * argument instead of reading `Date.now()`, so every case here is exact. Most
 * candidates are terminal and ignore it entirely — pinning it is what proves
 * that.
 */
const NOW_MS = new Date("2026-08-04T18:05:00.000Z").getTime();

/**
 * ISS-6005: the record-mutation anchor the non-`updated` comparators must be
 * blind to. Every fixture that is not exercising `compareByRecordUpdatedAt`
 * shares this ONE instant on both `@updatedAt` columns, so a duration/owner/
 * status assertion can never be satisfied by record recency leaking into the
 * order — if one of those comparators started reading this clock, the shared
 * value would make it a no-op tiebreak rather than silently reorder the page.
 */
const RECORD_UPDATED_BASE = new Date("2026-05-20T17:00:00.000Z");

/**
 * The status/awaiting-input columns the duration/owner comparators ignore. A
 * non-awaiting, terminal `completed` shape keeps those candidates out of the
 * Waiting projection so status has no bearing on the duration/owner assertions.
 */
const NON_WAITING_STATUS_FIELDS = {
  awaitingInputSince: null,
  artifact: { status: "completed", updatedAt: RECORD_UPDATED_BASE },
  updatedAt: RECORD_UPDATED_BASE,
} satisfies Pick<
  DisplaySortCandidate,
  "awaitingInputSince" | "artifact" | "updatedAt"
>;

/**
 * ISS-5366: a staleness anchor of "just now".
 *
 * The displayed-status projection folds an `active` row silent past the display
 * threshold to `stale`. These fixtures exercise the duration, owner, and
 * lifecycle-rank orderings, so they pin a FRESH anchor to keep the staleness
 * fold out of the comparison — anchoring them on the fixed `START` would make
 * them silently turn Stale as wall-clock time passed and rewrite the expected
 * order. Read at call time so it tracks a `vi.setSystemTime` clock too.
 */
function freshAnchor(): Date {
  return new Date();
}

/**
 * A TERMINAL candidate whose Duration is `durationMs` (> 0), measured from a
 * fixed start to its own `sessionEndedAt` — the ISS-5131 rule the cell renders.
 */
function durationCandidate(
  artifactId: string,
  durationMs: number
): DisplaySortCandidate {
  return {
    artifactId,
    sessionStartedAt: START,
    lastActivityAt: freshAnchor(),
    sessionEndedAt: new Date(START.getTime() + durationMs),
    user: null,
    ...NON_WAITING_STATUS_FIELDS,
  };
}

/**
 * ISS-5131: a TERMINAL session with no end instant. One instant is not a span,
 * so the Duration cell renders BLANK and this candidate must key `null` and
 * collect with the other blanks — not rank as a 0 among the real minima.
 */
function unmeasurableCandidate(artifactId: string): DisplaySortCandidate {
  return {
    artifactId,
    sessionStartedAt: START,
    lastActivityAt: freshAnchor(),
    sessionEndedAt: null,
    user: null,
    ...NON_WAITING_STATUS_FIELDS,
  };
}

/**
 * ISS-5131: a session whose end precedes its start (clock skew). An end before
 * its start is nonsensical data, not a measured `0s`, so the cell renders blank
 * and the key is `null`.
 */
function negativeSpanCandidate(artifactId: string): DisplaySortCandidate {
  return {
    artifactId,
    sessionStartedAt: START,
    lastActivityAt: freshAnchor(),
    sessionEndedAt: new Date(START.getTime() - 5000),
    user: null,
    ...NON_WAITING_STATUS_FIELDS,
  };
}

function ownerCandidate(
  artifactId: string,
  user: DisplaySortCandidate["user"]
): DisplaySortCandidate {
  return {
    artifactId,
    sessionStartedAt: START,
    lastActivityAt: freshAnchor(),
    sessionEndedAt: new Date(START.getTime() + 1000),
    user,
    ...NON_WAITING_STATUS_FIELDS,
  };
}

/**
 * A candidate carrying only the fields the status comparator reads: its stored
 * status, awaiting-input timestamp, and end. The duration/owner columns are set
 * to fixed non-differentiating values so the status projection alone drives order.
 */
function statusCandidate(
  artifactId: string,
  opts: {
    storedStatus: string;
    awaitingInputSince?: Date | null;
    sessionEndedAt?: Date | null;
  }
): DisplaySortCandidate {
  return {
    artifactId,
    sessionStartedAt: START,
    lastActivityAt: freshAnchor(),
    sessionEndedAt: opts.sessionEndedAt ?? null,
    user: null,
    awaitingInputSince: opts.awaitingInputSince ?? null,
    artifact: { status: opts.storedStatus, updatedAt: RECORD_UPDATED_BASE },
    updatedAt: RECORD_UPDATED_BASE,
  };
}

function sortIds(
  candidates: DisplaySortCandidate[],
  compare: (
    a: DisplaySortCandidate,
    b: DisplaySortCandidate,
    dir: "asc" | "desc"
  ) => number,
  dir: "asc" | "desc"
): string[] {
  return [...candidates]
    .sort((a, b) => compare(a, b, dir))
    .map((c) => c.artifactId);
}

describe("resolveDisplayDurationMs (ISS-5131)", () => {
  it("measures a terminal session start -> endedAt, matching the rendered cell", () => {
    expect(
      resolveDisplayDurationMs(durationCandidate("s", 2268 * 1000), NOW_MS)
    ).toBe(2268 * 1000); // 37m48s
  });

  it("ignores a lastActivityAt that runs past endedAt — the reported 5.5x inflation", () => {
    // Session `019fb3e3`: COMPLETED, `lastActivityAt` six days past `endedAt`
    // because it tracks SYNC time. Keying on it reported 170h for a 31h run, and
    // the comparator then ordered the page by a number the cell does not render.
    const trueSpanMs = 31 * HOUR_MS + 4 * MINUTE_MS;
    expect(
      resolveDisplayDurationMs(
        {
          sessionStartedAt: START,
          sessionEndedAt: new Date(START.getTime() + trueSpanMs),
          ...NON_WAITING_STATUS_FIELDS,
        },
        NOW_MS
      )
    ).toBe(trueSpanMs);
  });

  it("measures a RUNNING session against the clock it is handed", () => {
    // wongk (#4409): this was a live-clock BOUNDED assertion — `>= 90m` and
    // `< 91m` around a `Date.now()` read the production code made separately.
    // The repo bans those: scheduler delay can flake it, and a one-minute range
    // is wide enough to hide a real regression. `nowMs` is now an argument, so
    // the span is exact and nothing depends on when the test runs.
    expect(
      resolveDisplayDurationMs(
        {
          sessionStartedAt: START,
          sessionEndedAt: null,
          artifact: { status: SESSION_STATUS.ACTIVE },
        },
        START.getTime() + 90 * MINUTE_MS
      )
    ).toBe(90 * MINUTE_MS);
  });

  it("ignores a stale endedAt on a session that is still running", () => {
    // Only the status picks the branch (ISS-5182 clears `endedAt` when an
    // inactive session resumes; until then a leftover value must not freeze it).
    expect(
      resolveDisplayDurationMs(
        {
          sessionStartedAt: START,
          sessionEndedAt: new Date(START.getTime() + 30 * MINUTE_MS),
          artifact: { status: SESSION_STATUS.ACTIVE },
        },
        START.getTime() + 90 * MINUTE_MS
      )
    ).toBe(90 * MINUTE_MS);
  });

  it("never reaches the clock for an INDETERMINATE status with no end instant", () => {
    // ISS-4997 + #4409: an unrecognized or display-only status asserts nothing
    // about the lifecycle, and the ABSENCE of an end instant is not evidence the
    // run continues. A clock-bound key here would have ordered a row the cell
    // renders blank as though it were the longest session on the page.
    for (const status of [
      "some-future-status",
      DISPLAYED_SESSION_STATUS.STALE,
      null,
    ]) {
      expect(
        resolveDisplayDurationMs(
          {
            sessionStartedAt: START,
            sessionEndedAt: null,
            artifact: { status },
          },
          NOW_MS
        )
      ).toBeNull();
    }
  });

  it("returns null for the defensive missing-start case", () => {
    expect(
      resolveDisplayDurationMs(
        {
          sessionStartedAt: null,
          sessionEndedAt: null,
          ...NON_WAITING_STATUS_FIELDS,
        },
        NOW_MS
      )
    ).toBeNull();
  });

  it("returns null for a TERMINAL session with no end instant — the cell renders blank", () => {
    // One instant is not a span. Ranking this as 0 would scatter a blank row
    // among the real zeros, an order the reader cannot verify from the screen.
    expect(
      resolveDisplayDurationMs(unmeasurableCandidate("s"), NOW_MS)
    ).toBeNull();
  });

  it("returns null for a zero-width span rather than a fabricated 0", () => {
    expect(
      resolveDisplayDurationMs(
        {
          sessionStartedAt: START,
          sessionEndedAt: START,
          ...NON_WAITING_STATUS_FIELDS,
        },
        NOW_MS
      )
    ).toBeNull();
  });

  it("returns null for a clock-skewed (end before start) span", () => {
    expect(
      resolveDisplayDurationMs(negativeSpanCandidate("s"), NOW_MS)
    ).toBeNull();
  });

  it("resolves an unrecognized or absent status by EVIDENCE (ISS-4997 version skew)", () => {
    const spanMs = 37 * MINUTE_MS;
    expect(
      resolveDisplayDurationMs(
        {
          sessionStartedAt: START,
          sessionEndedAt: new Date(START.getTime() + spanMs),
          artifact: { status: "some-future-status" },
        },
        NOW_MS
      )
    ).toBe(spanMs);
    expect(
      resolveDisplayDurationMs(
        {
          sessionStartedAt: START,
          sessionEndedAt: new Date(START.getTime() + spanMs),
          artifact: null,
        },
        NOW_MS
      )
    ).toBe(spanMs);
  });

  it("bounds the LEGACY terminal statuses too (ISS-4586)", () => {
    // A stored `completed`/`abandoned` row must not fall through to the running
    // branch and be measured against now().
    for (const status of ["completed", "abandoned"]) {
      expect(
        resolveDisplayDurationMs(
          {
            sessionStartedAt: START,
            sessionEndedAt: null,
            artifact: { status },
          },
          NOW_MS
        )
      ).toBeNull();
    }
  });
});

describe("compareByDisplayDuration (FEA-4297)", () => {
  it("sorts ascending by the DISPLAYED duration, not a divergent column", () => {
    // Durations that lexically/other-column-sort out of order but must be
    // monotonic by the real span: 3s, 4s, 5s, 1m2s, 37m48s.
    const candidates = [
      durationCandidate("d-37m48s", 2268 * 1000),
      durationCandidate("d-4s", 4000),
      durationCandidate("d-1m2s", 62 * 1000),
      durationCandidate("d-3s", 3000),
      durationCandidate("d-5s", 5000),
    ];
    expect(sortIds(candidates, compareByDisplayDuration, "asc")).toEqual([
      "d-3s",
      "d-4s",
      "d-5s",
      "d-1m2s",
      "d-37m48s",
    ]);
  });

  it("sorts descending by displayed duration (largest first)", () => {
    const candidates = [
      durationCandidate("d-4s", 4000),
      durationCandidate("d-37m48s", 2268 * 1000),
      durationCandidate("d-3s", 3000),
    ];
    expect(sortIds(candidates, compareByDisplayDuration, "desc")).toEqual([
      "d-37m48s",
      "d-4s",
      "d-3s",
    ]);
  });

  it("ISS-5131: keeps an UNMEASURABLE row with the blanks in BOTH directions", () => {
    // Its Duration cell renders blank, so it must never be interleaved with the
    // rows that show a number — in either direction.
    const candidates = [
      unmeasurableCandidate("d-blank"),
      durationCandidate("d-max", 2268 * 1000),
      durationCandidate("d-mid", 4000),
    ];
    expect(sortIds(candidates, compareByDisplayDuration, "desc")).toEqual([
      "d-max",
      "d-mid",
      "d-blank",
    ]);
    expect(sortIds(candidates, compareByDisplayDuration, "asc")).toEqual([
      "d-mid",
      "d-max",
      "d-blank",
    ]);
  });

  it("ISS-5131: sorts a clock-skew (negative-span) row with the blanks too", () => {
    // An end before its start is nonsensical data, not a 0s measurement, so the
    // cell is blank and the row collects with the other blanks.
    const candidates = [
      negativeSpanCandidate("d-skew"),
      unmeasurableCandidate("d-blank"),
      durationCandidate("d-3s", 3000),
    ];
    // The 3s row leads on ASC; the two blank rows follow, ordered by the unique
    // artifactId tiebreaker (desc): "d-skew" > "d-blank".
    expect(sortIds(candidates, compareByDisplayDuration, "asc")).toEqual([
      "d-3s",
      "d-skew",
      "d-blank",
    ]);
  });

  it("breaks ties on the unique artifactId so equal durations paginate deterministically (FEA-4329)", () => {
    const a = durationCandidate("aaa", 5000);
    const b = durationCandidate("bbb", 5000);
    // Identical durations → the tiebreaker (artifactId desc) is total & stable,
    // independent of input order.
    expect(sortIds([a, b], compareByDisplayDuration, "asc")).toEqual([
      "bbb",
      "aaa",
    ]);
    expect(sortIds([b, a], compareByDisplayDuration, "asc")).toEqual([
      "bbb",
      "aaa",
    ]);
  });
});

describe("resolveOwnerSortKey (FEA-4300)", () => {
  it("uses the trimmed 'First Last' display name, lower-cased", () => {
    expect(
      resolveOwnerSortKey(
        ownerCandidate("s", {
          firstName: "Ada",
          lastName: "Lovelace",
          email: "zzz@example.com",
        })
      )
    ).toBe("ada lovelace");
  });

  it("falls back to email when no name parts are set", () => {
    expect(
      resolveOwnerSortKey(
        ownerCandidate("s", {
          firstName: null,
          lastName: null,
          email: "grace@example.com",
        })
      )
    ).toBe("grace@example.com");
  });

  it("is null when there is no owner", () => {
    expect(resolveOwnerSortKey(ownerCandidate("s", null))).toBeNull();
  });
});

describe("compareByOwnerDisplayName (FEA-4300)", () => {
  it("orders by the displayed NAME, not the hidden email, when the two disagree", () => {
    // Display-name order is Ada < Zed; email order would be the REVERSE
    // (ada's email starts 'z', zed's starts 'a'). The sort must follow the name.
    const ada = ownerCandidate("row-ada", {
      firstName: "Ada",
      lastName: "Lovelace",
      email: "zzz@example.com",
    });
    const zed = ownerCandidate("row-zed", {
      firstName: "Zed",
      lastName: "Young",
      email: "aaa@example.com",
    });
    expect(sortIds([zed, ada], compareByOwnerDisplayName, "asc")).toEqual([
      "row-ada",
      "row-zed",
    ]);
  });

  it("compares case-insensitively (FEA-4300)", () => {
    const lower = ownerCandidate("row-lower", {
      firstName: "bob",
      lastName: "smith",
      email: "b@example.com",
    });
    const upper = ownerCandidate("row-upper", {
      firstName: "Alice",
      lastName: "Ng",
      email: "a@example.com",
    });
    // Case-insensitive: "alice ng" < "bob smith". A case-SENSITIVE order would
    // put uppercase 'A' before lowercase 'b' too, so flip with a lowercase-first
    // name to prove insensitivity: "aaron" (lower) < "Alice" (upper).
    expect(sortIds([lower, upper], compareByOwnerDisplayName, "asc")).toEqual([
      "row-upper",
      "row-lower",
    ]);

    const aaron = ownerCandidate("row-aaron", {
      firstName: "aaron",
      lastName: "zeta",
      email: "z@example.com",
    });
    expect(sortIds([upper, aaron], compareByOwnerDisplayName, "asc")).toEqual([
      "row-aaron",
      "row-upper",
    ]);
  });

  it("places owner-less sessions LAST on DESC (FEA-4330)", () => {
    const named = ownerCandidate("row-named", {
      firstName: "Zed",
      lastName: "Young",
      email: "z@example.com",
    });
    const none = ownerCandidate("row-none", null);
    expect(sortIds([none, named], compareByOwnerDisplayName, "desc")).toEqual([
      "row-named",
      "row-none",
    ]);
  });

  it("breaks ties on the unique artifactId for deterministic pagination (FEA-4329)", () => {
    const a = ownerCandidate("aaa", {
      firstName: "Sam",
      lastName: "Lee",
      email: "sam@example.com",
    });
    const b = ownerCandidate("bbb", {
      firstName: "Sam",
      lastName: "Lee",
      email: "sam2@example.com",
    });
    expect(sortIds([a, b], compareByOwnerDisplayName, "asc")).toEqual([
      "bbb",
      "aaa",
    ]);
  });
});

const AWAITING = new Date("2026-05-20T17:05:00.000Z");
const ENDED = new Date("2026-05-20T17:10:00.000Z");

describe("compareByDisplayedStatus staleness fold (ISS-5366)", () => {
  /** Comfortably past STALE_SESSION_DISPLAY_THRESHOLD_HOURS (24). */
  function staleAnchoredCandidate(artifactId: string): DisplaySortCandidate {
    return {
      artifactId,
      sessionStartedAt: START,
      lastActivityAt: new Date(Date.now() - 72 * HOUR_MS),
      sessionEndedAt: null,
      user: null,
      awaitingInputSince: null,
      artifact: {
        status: SESSION_STATUS.ACTIVE,
        updatedAt: RECORD_UPDATED_BASE,
      },
      updatedAt: RECORD_UPDATED_BASE,
    };
  }

  it("sorts a long-silent active row by its DISPLAYED Stale rank, not among the Active rows", () => {
    // The row badges "Stale", so it must not sort into the Active block — the
    // sort, the badge, and the Status facet now read one projection.
    const candidates = [
      staleAnchoredCandidate("row-stale"),
      statusCandidate("row-active", { storedStatus: SESSION_STATUS.ACTIVE }),
      statusCandidate("row-error", {
        storedStatus: SESSION_STATUS.ERROR,
        sessionEndedAt: ENDED,
      }),
    ];
    expect(sortIds(candidates, compareByDisplayedStatus, "asc")).toEqual([
      "row-active",
      "row-error",
      "row-stale",
    ]);
  });

  it("keeps an unrecognized status ranked last as Unknown", () => {
    const candidates = [
      statusCandidate("row-future", { storedStatus: "some-future-status" }),
      statusCandidate("row-active", { storedStatus: SESSION_STATUS.ACTIVE }),
    ];
    expect(sortIds(candidates, compareByDisplayedStatus, "asc")).toEqual([
      "row-active",
      "row-future",
    ]);
  });
});

describe("compareByDisplayedStatus (FEA-4301 / ISS-4586)", () => {
  it("orders ASC by the DISPLAYED status lifecycle: Active → Waiting → Inactive → Error", () => {
    const candidates = [
      statusCandidate("row-inactive", {
        storedStatus: SESSION_STATUS.INACTIVE,
        sessionEndedAt: ENDED,
      }),
      statusCandidate("row-active", { storedStatus: SESSION_STATUS.ACTIVE }),
      statusCandidate("row-error", {
        storedStatus: SESSION_STATUS.ERROR,
        sessionEndedAt: ENDED,
      }),
      // Stored `active`, but awaiting input → DISPLAYS as Waiting.
      statusCandidate("row-waiting", {
        storedStatus: SESSION_STATUS.ACTIVE,
        awaitingInputSince: AWAITING,
      }),
    ];
    expect(sortIds(candidates, compareByDisplayedStatus, "asc")).toEqual([
      "row-active",
      "row-waiting",
      "row-inactive",
      "row-error",
    ]);
  });

  it("sorts a displayed-Waiting row (stored active) as Waiting, NOT among the Active rows", () => {
    const active = statusCandidate("row-active", {
      storedStatus: SESSION_STATUS.ACTIVE,
    });
    // Same stored status as `active`, but awaiting input → Waiting.
    const waiting = statusCandidate("row-waiting", {
      storedStatus: SESSION_STATUS.ACTIVE,
      awaitingInputSince: AWAITING,
    });
    const inactive = statusCandidate("row-inactive", {
      storedStatus: SESSION_STATUS.INACTIVE,
      sessionEndedAt: ENDED,
    });
    // The Waiting row lands BETWEEN Active and Completed — a raw-status sort would
    // have collapsed it onto the Active row (both store `active`).
    expect(
      sortIds([inactive, waiting, active], compareByDisplayedStatus, "asc")
    ).toEqual(["row-active", "row-waiting", "row-inactive"]);
  });

  it("breaks ties within the same displayed status on the unique artifactId (FEA-4329)", () => {
    const a = statusCandidate("aaa", { storedStatus: SESSION_STATUS.ACTIVE });
    const b = statusCandidate("bbb", { storedStatus: SESSION_STATUS.ACTIVE });
    // Same displayed status → the artifactId-desc tiebreaker is total and stable
    // regardless of input order.
    expect(sortIds([a, b], compareByDisplayedStatus, "asc")).toEqual([
      "bbb",
      "aaa",
    ]);
    expect(sortIds([b, a], compareByDisplayedStatus, "asc")).toEqual([
      "bbb",
      "aaa",
    ]);
  });

  it("keeps an UNKNOWN status LAST in BOTH directions (thread #3: not promoted to the front on desc)", () => {
    const active = statusCandidate("row-active", {
      storedStatus: SESSION_STATUS.ACTIVE,
    });
    // ISS-5592: the KNOWN comparator is `inactive`, not the retired `completed`.
    // That spelling is unrecognized now, so it ranks WITH the unknown row and
    // cannot serve as the known half of this comparison.
    const inactive = statusCandidate("row-inactive", {
      storedStatus: SESSION_STATUS.INACTIVE,
      sessionEndedAt: ENDED,
    });
    // A future status the vocabulary does not cover.
    const unknown = statusCandidate("row-unknown", {
      storedStatus: "quantum-flux",
    });
    // ASC: known lifecycle first, unknown last.
    expect(
      sortIds([unknown, inactive, active], compareByDisplayedStatus, "asc")
    ).toEqual(["row-active", "row-inactive", "row-unknown"]);
    // DESC: the KNOWN ranks reverse, but the unknown stays LAST — a
    // direction-flipped raw rank delta would have put it FIRST here.
    expect(
      sortIds([active, inactive, unknown], compareByDisplayedStatus, "desc")
    ).toEqual(["row-inactive", "row-active", "row-unknown"]);
  });
});

/**
 * ISS-5131 (#4409 review): `?sortBy=duration` across PAGE requests.
 *
 * `findDisplayValueSortedPage` re-materializes the candidate set, re-sorts it in
 * memory and slices `offset..offset+limit` on every single request, so the
 * page-2 call sorts against a fresh clock. Running rows grow by the seconds
 * between the two calls while terminal rows do not, and a running row sitting
 * within that gap of a terminal row on the page boundary crosses it — the reader
 * sees that session twice, or never.
 *
 * The comparator is exercised through the exported `compareByDisplayDuration`,
 * with the SYSTEM clock moved between the two "requests", so this asserts the
 * production quantization rather than reimplementing it.
 */
describe("compareByDisplayDuration across page requests (#4409)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // A running row and a terminal row whose spans are seconds apart: the pair
  // that swaps if the running row's key grows between two requests.
  function neighbouringPair(): DisplaySortCandidate[] {
    return [
      {
        artifactId: "terminal",
        sessionStartedAt: START,
        lastActivityAt: freshAnchor(),
        sessionEndedAt: new Date(START.getTime() + 90 * MINUTE_MS + 20_000),
        user: null,
        awaitingInputSince: null,
        artifact: { status: "completed", updatedAt: RECORD_UPDATED_BASE },
        updatedAt: RECORD_UPDATED_BASE,
      },
      {
        artifactId: "running",
        sessionStartedAt: START,
        lastActivityAt: freshAnchor(),
        sessionEndedAt: null,
        user: null,
        awaitingInputSince: null,
        artifact: {
          status: SESSION_STATUS.ACTIVE,
          updatedAt: RECORD_UPDATED_BASE,
        },
        updatedAt: RECORD_UPDATED_BASE,
      },
    ];
  }

  function orderAt(isoNow: string): string[] {
    vi.setSystemTime(new Date(isoNow));
    return sortIds(neighbouringPair(), compareByDisplayDuration, "desc");
  }

  it("keeps the order stable when two requests land in the same clock bucket", () => {
    vi.useFakeTimers();
    // Both reads sit inside one minute. The running row's real elapsed time grew
    // by 30s between them and crossed the terminal row's 90m20s span — reading
    // the raw clock would swap the two and duplicate one row across the page
    // boundary.
    const first = orderAt("2026-05-20T18:30:10.000Z");
    const second = orderAt("2026-05-20T18:30:40.000Z");
    expect(second).toEqual(first);
  });

  it("still tracks the clock across buckets", () => {
    // Quantizing must not freeze the sort: a running session really does
    // overtake a shorter terminal one, and the order has to say so eventually.
    vi.useFakeTimers();
    const early = orderAt("2026-05-20T18:00:00.000Z");
    const later = orderAt("2026-05-20T19:00:00.000Z");
    expect(early).toEqual(["terminal", "running"]);
    expect(later).toEqual(["running", "terminal"]);
  });
});

/**
 * ISS-6005: the `Updated` column's ordering. The rendered value is
 * `resolveRecordUpdatedAt` — MAX of the session_detail row's own `@updatedAt`
 * and its parent artifact row's — and the comparator must order by that SAME
 * derivation, or the page ranks rows by a number no cell shows.
 */
describe("compareByRecordUpdatedAt (ISS-6005)", () => {
  const DETAIL_OLD = new Date("2026-05-01T00:00:00.000Z");
  const DETAIL_NEW = new Date("2026-06-01T00:00:00.000Z");
  const PARENT_NEWEST = new Date("2026-07-01T00:00:00.000Z");

  function recordCandidate(
    artifactId: string,
    detailUpdatedAt: Date,
    parentUpdatedAt: Date
  ): DisplaySortCandidate {
    return {
      artifactId,
      sessionStartedAt: START,
      lastActivityAt: freshAnchor(),
      sessionEndedAt: new Date(START.getTime() + HOUR_MS),
      user: null,
      awaitingInputSince: null,
      artifact: { status: "completed", updatedAt: parentUpdatedAt },
      updatedAt: detailUpdatedAt,
    };
  }

  it("resolves the record clock as the MAX of the two @updatedAt columns", () => {
    // Either column may be the freshest, so both directions are pinned. This is
    // the case the column exists for: a parent-row mutation (a status fold, and
    // the forward-looking comment/tag writes) never touches the detail row, so
    // reading only `session_detail.updated_at` would render a stale instant.
    expect(
      resolveRecordUpdatedAt({
        updatedAt: DETAIL_OLD,
        artifact: { updatedAt: PARENT_NEWEST },
      })
    ).toEqual(PARENT_NEWEST);
    expect(
      resolveRecordUpdatedAt({
        updatedAt: DETAIL_NEW,
        artifact: { updatedAt: DETAIL_OLD },
      })
    ).toEqual(DETAIL_NEW);
  });

  it("orders by the record clock, newest first on desc", () => {
    const candidates = [
      recordCandidate("row-oldest", DETAIL_OLD, DETAIL_OLD),
      recordCandidate("row-newest", DETAIL_OLD, PARENT_NEWEST),
      recordCandidate("row-middle", DETAIL_NEW, DETAIL_OLD),
    ];
    // `row-newest` wins on its PARENT's clock while its own detail row is the
    // oldest in the set — the assertion is only satisfiable if the comparator
    // reads the same MAX the cell renders, not `updatedAt` alone.
    expect(sortIds(candidates, compareByRecordUpdatedAt, "desc")).toEqual([
      "row-newest",
      "row-middle",
      "row-oldest",
    ]);
    expect(sortIds(candidates, compareByRecordUpdatedAt, "asc")).toEqual([
      "row-oldest",
      "row-middle",
      "row-newest",
    ]);
  });

  it("resolves to null when NEITHER column was selected, and collects those last", () => {
    // Both columns are `@updatedAt` and non-null in the schema, but presence is
    // a property of the caller's SELECT: `toSessionListItem` is shared by the
    // list and detail reads, and a select that does not project them yields
    // `undefined` at runtime with no type error. Dereferencing that threw a 500
    // on the whole response, so the resolver degrades instead — and a row with
    // no comparable key sorts LAST rather than among real instants.
    expect(resolveRecordUpdatedAt({})).toBeNull();
    // One column present is still an answer — the MAX of one value.
    expect(resolveRecordUpdatedAt({ updatedAt: DETAIL_NEW })).toEqual(
      DETAIL_NEW
    );
    expect(
      resolveRecordUpdatedAt({ artifact: { updatedAt: PARENT_NEWEST } })
    ).toEqual(PARENT_NEWEST);

    const unresolvable = {
      ...recordCandidate("row-unresolvable", DETAIL_NEW, DETAIL_NEW),
      artifact: { status: "completed" },
      updatedAt: undefined,
    } as unknown as DisplaySortCandidate;
    const ordered = sortIds(
      [unresolvable, recordCandidate("row-real", DETAIL_OLD, DETAIL_OLD)],
      compareByRecordUpdatedAt,
      "desc"
    );
    expect(ordered).toEqual(["row-real", "row-unresolvable"]);
  });

  it("falls to the unique artifactId tiebreaker on an exact tie", () => {
    // A tie is otherwise the degenerate ordering, and FEA-4329 requires it
    // resolve deterministically or a row can repeat across pages.
    //
    // thadeusb review: sorting ONE array twice and comparing the two results
    // proves nothing — `Array#sort` is deterministic for a given input, so that
    // assertion holds even if `compareTiebreaker` returned 0 and left the tie
    // unresolved. The claim is that the order is independent of the INPUT
    // order, so both orderings are sorted and both are pinned to the same
    // concrete result, matching the duration and status tiebreaker tests.
    const a = recordCandidate("row-a", DETAIL_NEW, DETAIL_NEW);
    const b = recordCandidate("row-b", DETAIL_NEW, DETAIL_NEW);

    // `compareTiebreaker` is artifactId DESCENDING and takes no direction, so
    // `row-b` leads in both directions — asserted rather than assumed, because
    // a tiebreaker that quietly followed `dir` would reorder a tied page when
    // the user flipped the header and reintroduce the repeat this guards.
    for (const dir of ["asc", "desc"] as const) {
      expect(sortIds([a, b], compareByRecordUpdatedAt, dir)).toEqual([
        "row-b",
        "row-a",
      ]);
      expect(sortIds([b, a], compareByRecordUpdatedAt, dir)).toEqual([
        "row-b",
        "row-a",
      ]);
    }
  });
});

/**
 * ISS-6051: every comparator resolves each candidate's sort key ONCE per sort,
 * not once per COMPARISON.
 *
 * `findDisplayValueSortedPage` sorts the whole bounded candidate set in memory
 * on every page request, so a key derived inside the comparator runs ~2·n·log n
 * times — ~266,000 derivations over the 10,000-row cap where 10,000 do. For the
 * duration and status keys it is also a CORRECTNESS property: both are measured
 * against a clock, so a row re-derived mid-sort can be judged by two different
 * rules within one sort and make the comparator inconsistent.
 *
 * Each case counts reads of the ONE candidate field its comparator's derivation
 * touches, through the exported comparator, and pins the count to the number of
 * candidates. Sorting n elements takes at least n-1 comparisons and each reads
 * BOTH operands, so a comparator that re-derived per comparison would read at
 * least 2(n-1) times — above n for every n > 2, whatever order the runtime's
 * sort happens to take. (Measured against a neutered memo: 14/14/36/14 reads for
 * these four cases, against the 8 asserted.)
 */
describe("sort-key derivation per candidate (ISS-6051)", () => {
  const ROW_COUNT = 8;
  /**
   * ISS-6270: the memoized derivations that read `sessionStartedAt` when the
   * Duration key is resolved — the span, and the displayed-status projection
   * whose staleness fold anchors on it. Both are per-candidate memos, so the
   * per-candidate read count is this constant and not the sort's comparison
   * count.
   */
  const DURATION_KEY_DERIVATIONS = 2;

  /**
   * Replace one field with a counting getter. The derivations under test each
   * read their inputs exactly once per call, so the read count IS the derivation
   * count.
   */
  function countReadsOf(
    candidate: DisplaySortCandidate,
    field: keyof DisplaySortCandidate,
    counter: { reads: number }
  ): DisplaySortCandidate {
    const value = candidate[field];
    return Object.defineProperty({ ...candidate }, field, {
      enumerable: true,
      get() {
        counter.reads += 1;
        return value;
      },
    });
  }

  function rowIndexes(): number[] {
    return Array.from({ length: ROW_COUNT }, (_, index) => index);
  }

  it("derives the duration key once per candidate", () => {
    const counter = { reads: 0 };
    const candidates = rowIndexes().map((index) =>
      countReadsOf(
        durationCandidate(`row-${index}`, (index + 1) * MINUTE_MS),
        "sessionStartedAt",
        counter
      )
    );
    sortIds(candidates, compareByDisplayDuration, "asc");
    // ISS-6270 made this key a COMPOSITION of two separately-memoized
    // derivations: the span itself, and the DISPLAYED status it is keyed on
    // (whose staleness fold reads the same `sessionStartedAt` as its anchor).
    // Each is still resolved exactly once per candidate — 2n reads, not the
    // ~2·n·log n a per-comparison derivation costs — so the invariant this case
    // pins is unchanged and only the constant moved. The bound below is what
    // actually enforces it: at n=8 a per-comparison derivation reads at least
    // 2·2(n-1) = 28.
    expect(counter.reads).toBe(ROW_COUNT * DURATION_KEY_DERIVATIONS);
    expect(counter.reads).toBeLessThan(
      2 * DURATION_KEY_DERIVATIONS * (ROW_COUNT - 1)
    );
  });

  it("derives the owner display name once per candidate", () => {
    const counter = { reads: 0 };
    const candidates = rowIndexes().map((index) =>
      countReadsOf(
        ownerCandidate(`row-${index}`, {
          firstName: `Owner${index}`,
          lastName: "Example",
          email: `owner${index}@example.com`,
        }),
        "user",
        counter
      )
    );
    sortIds(candidates, compareByOwnerDisplayName, "asc");
    expect(counter.reads).toBe(ROW_COUNT);
  });

  it("projects the displayed status once per candidate, against one clock read", () => {
    const counter = { reads: 0 };
    const candidates = rowIndexes().map((index) =>
      countReadsOf(
        statusCandidate(`row-${index}`, {
          // Alternating displayed statuses so the ranks differ and the sort
          // cannot short-circuit on an all-equal population.
          storedStatus:
            index % 2 === 0 ? SESSION_STATUS.ACTIVE : SESSION_STATUS.ERROR,
          sessionEndedAt: index % 2 === 0 ? null : ENDED,
        }),
        "awaitingInputSince",
        counter
      )
    );
    sortIds(candidates, compareByDisplayedStatus, "asc");
    expect(counter.reads).toBe(ROW_COUNT);
  });

  it("derives the record-updated key once per candidate", () => {
    const counter = { reads: 0 };
    const candidates = rowIndexes().map((index) =>
      countReadsOf(
        {
          ...durationCandidate(`row-${index}`, HOUR_MS),
          updatedAt: new Date(RECORD_UPDATED_BASE.getTime() + index * HOUR_MS),
        },
        "updatedAt",
        counter
      )
    );
    sortIds(candidates, compareByRecordUpdatedAt, "desc");
    expect(counter.reads).toBe(ROW_COUNT);
  });
});
