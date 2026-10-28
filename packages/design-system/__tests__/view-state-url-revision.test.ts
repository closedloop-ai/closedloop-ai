import {
  applyLinkedViewRevision,
  LinkedViewOutcome,
  readLinkedViewRevision,
  VIEW_REVISION_PARAM,
  writeViewRevisionParam,
} from "@closedloop-ai/design-system/lib/view-state-url-revision";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * ISS-9480 — the URL carrier for the model revision.
 *
 * The saved-view carrier is covered in `view-state-codec.test.ts`. What is
 * specific here is that a link is a FLAT param set written by a build the reader
 * cannot interrogate, so the cases that matter are the three provenances a
 * reader has to tell apart: a link older than this build, one newer, and one
 * that is simply junk.
 */

/** The revision this build writes in these cases. */
const CURRENT_REVISION = 2;

/** Revision 1 named the facet `state`; revision 2 renamed it to `status`. */
function renameStateToStatus(params: URLSearchParams, from: number): void {
  migrateCalls.push({ from });
  const legacy = params.getAll("state");
  if (legacy.length === 0) {
    return;
  }
  params.delete("state");
  for (const value of legacy) {
    params.append("status", value);
  }
}

let migrateCalls: { from: number }[] = [];

function spec(migrate = renameStateToStatus) {
  return { current: CURRENT_REVISION, migrate };
}

describe("readLinkedViewRevision", () => {
  it("reads a link that states no revision as legacy rather than as corrupt", () => {
    // Every link shared before versioning existed carries no param, and reading
    // those as legacy is what lets them be migrated instead of refused.
    expect(readLinkedViewRevision(new URLSearchParams("status=open"))).toBe(0);
  });

  it("reads the revision a link states", () => {
    expect(
      readLinkedViewRevision(new URLSearchParams(`${VIEW_REVISION_PARAM}=3`))
    ).toBe(3);
  });

  it("answers null for a stated revision that is not one", () => {
    // `0x10`, `1e3`, `+7` and a padded ` 3 ` are the dangerous half: `Number`
    // reads them as 16, 1000, 7 and 3, and a value ABOVE this build's revision
    // is carried verbatim rather than refused — so a mangled param would get
    // the link APPLIED unmigrated. `""` is the other direction, reading as the
    // legacy revision and inviting a migration the link never asked for.
    for (const raw of [
      "banana",
      "-1",
      "1.5",
      "",
      "0x10",
      "1e3",
      "+7",
      " 3 ",
      "Infinity",
    ]) {
      expect(
        readLinkedViewRevision(
          new URLSearchParams(`${VIEW_REVISION_PARAM}=${raw}`)
        )
      ).toBeNull();
    }
  });
});

describe("applyLinkedViewRevision", () => {
  beforeEach(() => {
    migrateCalls = [];
  });

  it("migrates a legacy link and stamps it with this build's revision", () => {
    const params = new URLSearchParams("state=open&state=merged&page=2");

    expect(applyLinkedViewRevision(params, spec())).toBe(
      LinkedViewOutcome.Current
    );

    // Two values, not one: a single-value fixture cannot tell a per-value
    // rename from one that keeps only the first.
    expect(params.getAll("status")).toEqual(["open", "merged"]);
    expect(params.getAll("state")).toEqual([]);
    expect(params.get("page")).toBe("2");
    expect(params.get(VIEW_REVISION_PARAM)).toBe(String(CURRENT_REVISION));
    expect(migrateCalls).toEqual([{ from: 0 }]);
  });

  it("reports a link from a newer build apart from a current one, and leaves it exactly as it arrived", () => {
    // Its params are in a vocabulary this build does not know, so migrating
    // would repair them toward a shape they already passed through, and
    // lowering the stamp over params it did not rewrite would misstate them.
    const params = new URLSearchParams(
      `${VIEW_REVISION_PARAM}=7&flavour=spicy`
    );

    expect(applyLinkedViewRevision(params, spec())).toBe(
      LinkedViewOutcome.Newer
    );

    expect(params.get(VIEW_REVISION_PARAM)).toBe("7");
    expect(params.get("flavour")).toBe("spicy");
    expect(migrateCalls).toEqual([]);
  });

  it("refuses a link whose stated revision is unreadable, without touching it", () => {
    const params = new URLSearchParams(
      `${VIEW_REVISION_PARAM}=banana&state=open`
    );

    expect(applyLinkedViewRevision(params, spec())).toBe(
      LinkedViewOutcome.Refused
    );

    // Unmigrated AND unstamped: the caller falls back to the reader's stored
    // view, so a half-repaired param set must not be left behind for it.
    expect(params.getAll("state")).toEqual(["open"]);
    expect(params.getAll("status")).toEqual([]);
    expect(params.get(VIEW_REVISION_PARAM)).toBe("banana");
    expect(migrateCalls).toEqual([]);
  });

  it("refuses a link that states two revisions, rather than migrating it as the first", () => {
    // Legacy first, newer second: first-wins would migrate this as revision 0
    // and re-stamp it as current, down-levelling a link a newer build wrote.
    const params = new URLSearchParams(
      `${VIEW_REVISION_PARAM}=0&${VIEW_REVISION_PARAM}=7&state=open`
    );

    expect(applyLinkedViewRevision(params, spec())).toBe(
      LinkedViewOutcome.Refused
    );

    expect(params.getAll(VIEW_REVISION_PARAM)).toEqual(["0", "7"]);
    expect(params.getAll("state")).toEqual(["open"]);
    expect(migrateCalls).toEqual([]);
  });

  it("rewinds a link whose migration throws part way through, rather than leaving it half-migrated", () => {
    // The migrate MUTATES BEFORE IT THROWS, which is the whole case and the
    // shape the contract is written for: a migration that renames one facet and
    // then fails on the next has already edited the caller's object. A
    // side-effect-free throw cannot tell a rewind from its absence, so it would
    // pass whether or not one happens.
    const params = new URLSearchParams("state=open&state=merged&page=2");

    expect(
      applyLinkedViewRevision(
        params,
        spec((migrating) => {
          migrating.delete("state");
          migrating.append("status", "open");
          throw new Error("unreadable link");
        })
      )
    ).toBe(LinkedViewOutcome.Refused);

    // Refused AND untouched — the `Refused` return is what makes the caller fall
    // back to the stored view, so anything left behind here rides into the next
    // URL that caller writes.
    expect(params.toString()).toBe("state=open&state=merged&page=2");
  });

  it("runs no migration for a link already at this build's revision", () => {
    const params = new URLSearchParams(
      `${VIEW_REVISION_PARAM}=${CURRENT_REVISION}&status=open`
    );

    expect(applyLinkedViewRevision(params, spec())).toBe(
      LinkedViewOutcome.Current
    );

    expect(migrateCalls).toEqual([]);
    expect(params.getAll("status")).toEqual(["open"]);
  });
});

describe("writeViewRevisionParam", () => {
  it("omits the param at the legacy revision so a default link stays clean", () => {
    // Same convention as the page and page-size writers: a link describing the
    // default states nothing. A surface that has never revised its model must
    // not start emitting a param into every URL its readers share.
    const params = new URLSearchParams("status=open");

    writeViewRevisionParam(params, 0);

    expect(params.toString()).toBe("status=open");
  });

  it("writes the revision once a surface has revised its model", () => {
    const params = new URLSearchParams("status=open");

    writeViewRevisionParam(params, 3);

    expect(params.get(VIEW_REVISION_PARAM)).toBe("3");
  });

  it("replaces a previously stated revision rather than appending a second", () => {
    const params = new URLSearchParams(`${VIEW_REVISION_PARAM}=1`);

    writeViewRevisionParam(params, 3);

    expect(params.getAll(VIEW_REVISION_PARAM)).toEqual(["3"]);
  });
});
