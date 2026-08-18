import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { DiagnosticsWithheldRow } from "../../../../shared/diagnostics-contract";
import { WithheldTab } from "../withheld-tab";

function withheldRow(
  overrides: Partial<DiagnosticsWithheldRow> = {}
): DiagnosticsWithheldRow {
  return {
    rootRawId: "ses_root",
    sourcePath: "/store/opencode.db",
    withheldCount: 2,
    reason: "token count -5 is not a valid count",
    withheldTokens: 4321,
    withheldCacheTokens: 51_884,
    earliestChildStartedAt: "2026-08-01T00:00:00.000Z",
    latestChildEndedAt: "2026-08-01T05:00:00.000Z",
    windowPartial: false,
    observedAt: "2026-08-06T00:00:00.000Z",
    ...overrides,
  };
}

/** Copy assertions, hoisted per Ultracite's `useTopLevelRegex`. */
const TWO_WITHHELD_RE = /2 subagent sessions withheld, 4,321 tokens missing/;
const FIVE_WITHHELD_RE = /5 subagent sessions withheld, 100 tokens missing/;
const NONE_WITHHELD_RE = /No subagent sessions are currently withheld/;
const UNAVAILABLE_RE = /Withheld data unavailable/;
const ANY_UNAVAILABLE_RE = /unavailable/i;
const REGION_NAME_RE = /Withheld OpenCode Subagents/;
const STORE_IS_COMPLETE_RE = /store is complete/i;
const HALF_KNOWN_WINDOW_RE = / to Unknown$/;
const RAW_ISO_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const TOKEN_TOTAL_UNAVAILABLE_RE = /token total unavailable/i;
const CACHE_NOTE_RE = /51,884 cache tokens are missing/;
const POSSIBLY_WIDER_RE = /Possibly wider/;
const NOT_SCANNED_RE = /No OpenCode store has reported yet/;
const DOES_NOT_COVER_RE = /does not cover a parent that failed to parse/;
const COVERS_TWO_STORES_RE = /Totals cover 2 stores/;
const ONE_UNSCANNED_RE = /1 of them has not reported a scan/;

/** A store that has completed a scan, so an empty set is a real completeness claim. */
const SCANS = [
  { sourcePath: "/store/opencode.db", observedAt: "2026-08-06T00:00:00.000Z" },
];

describe("WithheldTab (ISS-5266)", () => {
  it("states the shortfall as withheld sessions and missing tokens, not as an absence", () => {
    render(<WithheldTab scans={SCANS} withheld={[withheldRow()]} />);

    // The exact spend is the point: a withhold that reported only "some data is
    // missing" would leave the under-count just as unquantified as a zero did.
    expect(screen.getByText(TWO_WITHHELD_RE)).toBeDefined();
    expect(screen.getByText("ses_root")).toBeDefined();
    expect(screen.getByText("/store/opencode.db")).toBeDefined();
  });

  it("reports a real zero as complete, distinctly from an unknown", () => {
    render(<WithheldTab scans={SCANS} withheld={[]} />);

    expect(screen.getByText(NONE_WITHHELD_RE)).toBeDefined();
    expect(screen.queryByText(ANY_UNAVAILABLE_RE)).toBeNull();
  });

  it("claims only that nothing is withheld, never that every store is complete", () => {
    render(<WithheldTab scans={SCANS} withheld={[]} />);

    // The record proves no store is CURRENTLY withholding; it cannot prove a
    // store was ever imported. Overstating that on the one tab built to stop the
    // UI overstating what it knows would be self-defeating.
    expect(screen.queryByText(STORE_IS_COMPLETE_RE)).toBeNull();
  });

  it("reports an absent field as UNKNOWN, never as nothing withheld", () => {
    // A payload from a producer that predates this field. Answering "none
    // withheld" here would be the exact false reassurance the tab exists to
    // remove, so the two states must not collapse.
    render(<WithheldTab scans={SCANS} withheld={undefined} />);

    expect(screen.getByText(UNAVAILABLE_RE)).toBeDefined();
    expect(screen.queryByText(NONE_WITHHELD_RE)).toBeNull();
  });

  it("gives the unknown state its own alert, so it is not drawn like the complete state", () => {
    const { container: unknown } = render(
      <WithheldTab scans={SCANS} withheld={undefined} />
    );
    const unknownAlerts = unknown.querySelectorAll('[role="alert"]').length;
    const { container: complete } = render(
      <WithheldTab scans={SCANS} withheld={[]} />
    );
    const completeAlerts = complete.querySelectorAll('[role="alert"]').length;

    expect(unknownAlerts).toBeGreaterThan(0);
    expect(completeAlerts).toBe(0);
  });

  it("renders an untimed subtree's window as Unknown rather than an instant", () => {
    render(
      <WithheldTab
        scans={SCANS}
        withheld={[
          withheldRow({
            earliestChildStartedAt: null,
            latestChildEndedAt: null,
          }),
        ]}
      />
    );

    expect(screen.getByText("Unknown")).toBeDefined();
  });

  it("keeps the known end of a half-known window instead of collapsing it", () => {
    render(
      <WithheldTab
        scans={SCANS}
        withheld={[withheldRow({ latestChildEndedAt: null })]}
      />
    );

    expect(screen.getByText(HALF_KNOWN_WINDOW_RE)).toBeDefined();
  });

  it("renders instants as readable dates, never as raw ISO", () => {
    const { container } = render(
      <WithheldTab scans={SCANS} withheld={[withheldRow()]} />
    );

    // "2026-08-01T00:00:00.000Z" is not something a reader parses at a glance,
    // and it is the widest thing in the row. Both the affected window and the
    // last-seen instant go through the shared date formatter.
    expect(RAW_ISO_RE.test(container.textContent ?? "")).toBe(false);
  });

  it("marks a partial window as a lower bound rather than an exact span", () => {
    // A child carrying no instants is skipped, which makes the surviving
    // children's window look exact. Saying so is the difference between a bound
    // and a claim.
    render(
      <WithheldTab
        scans={SCANS}
        withheld={[withheldRow({ windowPartial: true })]}
      />
    );

    expect(screen.getByText(POSSIBLY_WIDER_RE)).toBeDefined();
  });

  it("states the cache shortfall on its own basis, not folded into the total", () => {
    // The dashboard headline total is SUM(input) + SUM(output), so quoting a
    // combined figure against it would not reconcile.
    render(<WithheldTab scans={SCANS} withheld={[withheldRow()]} />);

    expect(screen.getByText(TWO_WITHHELD_RE)).toBeDefined();
    expect(screen.getByText(CACHE_NOTE_RE)).toBeDefined();
  });

  it("renders an unavailable token total as unavailable, never as a zero", () => {
    // The aggregate left the JS-safe integer range, so its size is no longer
    // known. A rounded number under a label claiming an exact shortfall, or a
    // 0, would both be lies.
    render(
      <WithheldTab
        scans={SCANS}
        withheld={[
          withheldRow({ withheldTokens: null, withheldCacheTokens: null }),
        ]}
      />
    );

    expect(screen.getByText(TOKEN_TOTAL_UNAVAILABLE_RE)).toBeDefined();
    expect(screen.queryByText("0")).toBeNull();
  });

  it("keeps a whole total unavailable when any subtree's count is unknown", () => {
    // Summing the known rows and presenting that as the shortfall would
    // understate it while looking exact.
    render(
      <WithheldTab
        scans={SCANS}
        withheld={[
          withheldRow({ rootRawId: "a", withheldTokens: 10 }),
          withheldRow({ rootRawId: "b", withheldTokens: null }),
        ]}
      />
    );

    expect(screen.getByText(TOKEN_TOTAL_UNAVAILABLE_RE)).toBeDefined();
  });

  it("sums the shortfall across every withheld subtree", () => {
    render(
      <WithheldTab
        scans={SCANS}
        withheld={[
          withheldRow({ rootRawId: "a", withheldCount: 2, withheldTokens: 10 }),
          withheldRow({ rootRawId: "b", withheldCount: 3, withheldTokens: 90 }),
        ]}
      />
    );

    expect(screen.getByText(FIVE_WITHHELD_RE)).toBeDefined();
  });

  it("reports an empty set with NO completed scan as unknown, never as complete", () => {
    // An empty table is ambiguous three ways: nothing withheld, nothing
    // imported, or a failed reconcile. Only the first is complete, and calling
    // all three complete is the overclaim this tab exists to remove.
    render(<WithheldTab scans={[]} withheld={[]} />);

    expect(screen.getByText(NOT_SCANNED_RE)).toBeDefined();
    expect(screen.queryByText(NONE_WITHHELD_RE)).toBeNull();
  });

  it("treats an absent scan list as unknown, like an absent withhold list", () => {
    // A producer that cannot report scans must not be read as having reported
    // none, which would be the same version-skew conflation one field over.
    render(<WithheldTab scans={undefined} withheld={[]} />);

    expect(screen.getByText(UNAVAILABLE_RE)).toBeDefined();
    expect(screen.queryByText(NONE_WITHHELD_RE)).toBeNull();
  });

  it("names what the complete state does NOT cover", () => {
    // A root that failed to parse with no subagents beneath it never reaches
    // the withhold record, so this screen cannot speak to it and must say so
    // rather than let "nothing withheld" read as "nothing missing".
    render(<WithheldTab scans={SCANS} withheld={[]} />);

    expect(screen.getByText(DOES_NOT_COVER_RE)).toBeDefined();
  });

  it("discloses a total's provenance, including a store with no scan behind it", () => {
    // The totals sum every row regardless of store, so a claim left over from a
    // store that has stopped reporting silently inflates a number the reader
    // takes as the current gap. Saying how many stores are in it, and that one
    // of them has not reported, is what stops that being invisible.
    render(
      <WithheldTab
        scans={SCANS}
        withheld={[
          withheldRow({ rootRawId: "a" }),
          withheldRow({ rootRawId: "b", sourcePath: "/gone/opencode.db" }),
        ]}
      />
    );

    expect(screen.getByText(COVERS_TWO_STORES_RE)).toBeDefined();
    expect(screen.getByText(ONE_UNSCANNED_RE)).toBeDefined();
  });

  it("names its region so the table is not an anonymous grid", () => {
    render(<WithheldTab scans={SCANS} withheld={[withheldRow()]} />);

    expect(screen.getByRole("region", { name: REGION_NAME_RE })).toBeDefined();
  });
});
