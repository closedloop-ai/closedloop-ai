/**
 * ISS-5303 — `packaging-stage-path.mjs`, the module that decides WHERE the
 * Electron package is staged.
 *
 * The path it returns is not just a build output directory: `stage-packaging-app.mjs`
 * recursively deletes the stage root before repopulating it, and
 * `run-electron-builder.mjs` reads the same root. So the single variable segment
 * — `GITHUB_RUN_ID`, an externally supplied value — is the tail of a
 * recursive-delete target. `getPackagingStageId()` therefore refuses anything
 * that is not one bounded path segment, and that refusal is what these tests
 * pin: a `..`, a separator, or a space in that variable must abort packaging
 * rather than widen the delete root.
 *
 * Every case drives `process.env.GITHUB_RUN_ID` directly, because the module
 * reads it at call time with no injection seam. The original value is captured
 * at module load and restored with `Reflect.deleteProperty` when it was absent
 * — assigning `undefined` back would leave the STRING `"undefined"` in
 * `process.env`, which is itself a legal stage ID and would quietly mask the
 * unset-default case for every later test in this process.
 */
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import {
  getPackagingStageAppDir,
  getPackagingStageRoot,
} from "../scripts/packaging-stage-path.mjs";

const STAGE_ROOT_NAME = "closedloop-desktop-packaging-stage";
// `assert.throws` matches a RegExp against `String(error)`, so this is
// deliberately unanchored — the subject reads "Error: Unsafe packaging …".
const UNSAFE_STAGE_ID_MESSAGE = /Unsafe packaging stage ID/;

// A realistic GitHub Actions run id — a bare decimal string.
const RUN_ID = "17539182246";

const ORIGINAL_GITHUB_RUN_ID = process.env.GITHUB_RUN_ID;

// Ids that must never reach the filesystem. Each one, left unchecked, would
// either escape the stage root (`..`, a separator) or produce a segment the
// stager did not intend (a space, the empty string — note `""` survives the
// `?? "local"` default, since an empty string is not nullish).
const UNSAFE_STAGE_IDS: readonly { label: string; value: string }[] = [
  { label: "the empty string", value: "" },
  { label: "a bare parent-directory segment", value: ".." },
  { label: "a traversal behind a plausible run id", value: `${RUN_ID}/../..` },
  { label: "a POSIX path separator", value: `${RUN_ID}/app` },
  { label: "a Windows path separator", value: String.raw`${RUN_ID}\app` },
  { label: "a space", value: `${RUN_ID} 2` },
  { label: "an absolute path", value: "/tmp" },
];

function setRunId(value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, "GITHUB_RUN_ID");
    return;
  }
  process.env.GITHUB_RUN_ID = value;
}

afterEach(() => {
  setRunId(ORIGINAL_GITHUB_RUN_ID);
});

describe("ISS-5303: the packaging stage root", () => {
  test("falls back to the `local` segment when GITHUB_RUN_ID is unset", () => {
    // The developer path. CI always exports GITHUB_RUN_ID, so this branch is
    // only ever taken on a workstation — and it is the one this suite would
    // silently stop covering if the restore above wrote "undefined" instead of
    // deleting the key.
    setRunId(undefined);

    assert.equal(
      getPackagingStageRoot(),
      join(tmpdir(), STAGE_ROOT_NAME, "local")
    );
  });

  test("uses the GitHub Actions run id as the leaf segment", () => {
    // Concurrent CI runs on the same self-hosted runner share tmpdir, so the
    // run id is what keeps one job's recursive delete out of another's stage.
    setRunId(RUN_ID);

    assert.equal(
      getPackagingStageRoot(),
      join(tmpdir(), STAGE_ROOT_NAME, RUN_ID)
    );
  });

  test("accepts underscores and hyphens, so the guard is not a blanket reject", () => {
    // Positive control for the pattern. Without it, a guard that threw on
    // everything would still pass every rejection case below.
    setRunId("local_dry-run2");

    assert.equal(
      getPackagingStageRoot(),
      join(tmpdir(), STAGE_ROOT_NAME, "local_dry-run2")
    );
  });

  test("the app dir is the stage root plus exactly one `app` segment", () => {
    setRunId(RUN_ID);

    assert.equal(
      getPackagingStageAppDir(),
      join(tmpdir(), STAGE_ROOT_NAME, RUN_ID, "app")
    );
    assert.equal(
      getPackagingStageAppDir(),
      join(getPackagingStageRoot(), "app")
    );
  });
});

describe("ISS-5303: the stage id guards a recursive-delete root", () => {
  for (const { label, value } of UNSAFE_STAGE_IDS) {
    test(`rejects ${label}`, () => {
      setRunId(value);

      assert.throws(() => getPackagingStageRoot(), UNSAFE_STAGE_ID_MESSAGE);
    });
  }

  test("names the offending value in the error", () => {
    // The failure surfaces in a packaging log, where the actionable detail is
    // which value was rejected — not that some value was.
    setRunId(`${RUN_ID}/../..`);

    assert.throws(() => getPackagingStageRoot(), {
      message: `Unsafe packaging stage ID "${RUN_ID}/../..". Expected a single alphanumeric, underscore, or hyphen path segment.`,
    });
  });

  test("refuses through the app dir too, not only the root", () => {
    // `stage-packaging-app.mjs` deletes and repopulates via the app dir. A
    // guard that only fired on `getPackagingStageRoot()` would leave the
    // actual mutation path unprotected.
    setRunId("..");

    assert.throws(() => getPackagingStageAppDir(), UNSAFE_STAGE_ID_MESSAGE);
  });
});
