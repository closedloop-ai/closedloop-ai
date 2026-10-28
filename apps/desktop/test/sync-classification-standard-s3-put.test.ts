/**
 * @file sync-classification-standard-s3-put.test.ts
 * @description PRD-699 Appendix A conformance for its FOURTH named exception:
 * the transcript lane's S3 presigned PUT, split on the XML `<Code>` (ISS-8608 /
 * fix F6).
 *
 * A sibling of `sync-classification-standard-conformance.test.ts` rather than a
 * section inside it: that file had ~116 logical lines of headroom against the
 * 1,000-line ceiling and this arm needs more. Both import the same guards from
 * `helpers/sync-classification-standard.ts`, so the two are held to one
 * contract; only the tables differ.
 *
 * THE EXPECTED COLUMN IS WRITTEN OUT BY HAND, transcribed from Appendix A and
 * never derived from the module under test. That duplication IS the test.
 *
 * WHAT THIS COVERS THAT THE DRAIN SUITES DO NOT: the client's own body read.
 * Each cell drives the REAL `createDesktopTranscriptsClient` over a real
 * `Response`, so the `<Code>` has to survive being parsed, carried on the thrown
 * error, and read back — the whole wire path — before the classifier sees it.
 * What it does NOT execute is `recordFailure` itself: the counter each class
 * moves is `transcript-lane-wide-failure.test.ts`' and
 * `transcript-lane-stall-backoff.test.ts`' contract, and re-proving it here
 * would duplicate rather than extend.
 *
 * ON THE THREE DIVERGENCES. Appendix A's per-lane WORKSHEET puts `AccessDenied`
 * and "checksum mismatch" on the ITEM ladder. This build ships them
 * ENVIRONMENTAL, so the `standard` column records the worksheet as ratified and
 * a `Divergence` records what we ship — the shape the ledger exists for. They
 * are deliberate and permanent rather than debt, which is why each `owner` says
 * why it earns no follow-up ticket instead of naming one.
 */
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import type { TranscriptSyncClientError } from "../src/main/transcript/desktop-transcripts-client.js";
import { isLaneWideTranscriptFailure } from "../src/main/transcript-sync/transcript-failure-classification.js";
import {
  type Cell,
  type Lane,
  type Observation,
  registerLaneConformanceGuards,
  StandardClass,
} from "./helpers/sync-classification-standard.js";
import { s3UploadError } from "./helpers/transcript-s3-upload-fixtures.js";

/**
 * A cell plus the raw body override the two unreadable-body rows need. Declared
 * here rather than on the shared {@link Cell} because no other lane serves XML,
 * and widening the shared type for one arm is how a vocabulary rots.
 */
type S3Cell = Cell & {
  /** Served verbatim instead of the XML built from {@link Cell.code}. */
  readonly rawBody?: string;
  /** Marks a cell that exercises the hardwired default via an unmapped CODE. */
  readonly coversUnknownCode?: true;
};

const OWNER_ACCESS_DENIED =
  "ISS-8608, deliberate and permanent — earns no follow-up ticket. Appendix A's normative exception row splits only expiry/timeout vs CONTENT, and AccessDenied is neither: an expired presign and a bucket-policy denial are both conditions of the URL or the bucket, which every row shares, so neither reading is ever attributable to these bytes. The worksheet's 'genuine AccessDenied on a valid presign -> ladder' is its evidence record, not the standard.";

const OWNER_CHECKSUM =
  "ISS-8608, deliberate and permanent — earns no follow-up ticket. The worksheet lumps 'checksum mismatch' in with EntityTooLarge; on a streamed multi-MB body a mismatch is the in-transit corruption signal a re-read fixes, so it cannot be attributed to the bytes we hold. The deterministic malformed digest HEADER is a different failure and is not carried as ITEM either (see the module docstring).";

/**
 * Appendix A's S3 presigned-PUT worksheet, plus the statuses the platform can
 * inject on top, plus the two GATE rows this build owes its own refinement.
 */
const S3_PUT_CELLS: readonly S3Cell[] = [
  // --- expiry and signature: the exception's environmental half -------------
  {
    status: 403,
    code: "ExpiredToken",
    label: "403 ExpiredToken (a slow upload outlived its presign)",
    standard: StandardClass.Environmental,
  },
  {
    status: 403,
    code: "SignatureDoesNotMatch",
    label: "403 SignatureDoesNotMatch",
    standard: StandardClass.Environmental,
  },
  {
    status: 403,
    code: "RequestTimeTooSkewed",
    label: "403 RequestTimeTooSkewed",
    standard: StandardClass.Environmental,
  },
  {
    status: 403,
    code: "InvalidAccessKeyId",
    label: "403 InvalidAccessKeyId",
    standard: StandardClass.Environmental,
  },
  // --- timeout: the other environmental half --------------------------------
  {
    status: 400,
    code: "RequestTimeout",
    label: "400 RequestTimeout (socket stalled)",
    standard: StandardClass.Environmental,
  },
  {
    status: 400,
    code: "IncompleteBody",
    label: "400 IncompleteBody (socket stalled mid-part)",
    standard: StandardClass.Environmental,
  },
  // --- content: the exception's ITEM half -----------------------------------
  {
    status: 400,
    code: "EntityTooLarge",
    label: "400 EntityTooLarge (an object S3 will never accept)",
    standard: StandardClass.Item,
  },
  {
    status: 400,
    code: "KeyTooLongError",
    label: "400 KeyTooLongError (a key the desktop composed)",
    standard: StandardClass.Item,
  },
  // --- the three recorded divergences ---------------------------------------
  {
    status: 403,
    code: "AccessDenied",
    label: "403 AccessDenied (worksheet: ladder)",
    standard: StandardClass.Item,
    divergence: {
      observed: StandardClass.Environmental,
      owner: OWNER_ACCESS_DENIED,
    },
  },
  {
    status: 400,
    code: "BadDigest",
    label: "400 BadDigest (worksheet: checksum mismatch -> ladder)",
    standard: StandardClass.Item,
    divergence: {
      observed: StandardClass.Environmental,
      owner: OWNER_CHECKSUM,
    },
  },
  {
    status: 400,
    code: "XAmzContentSHA256Mismatch",
    label:
      "400 XAmzContentSHA256Mismatch (worksheet: checksum mismatch -> ladder)",
    standard: StandardClass.Item,
    divergence: {
      observed: StandardClass.Environmental,
      owner: OWNER_CHECKSUM,
    },
  },
  // --- statuses the refinement does not own; the status arm answers them -----
  {
    status: 503,
    code: "SlowDown",
    label: "503 SlowDown (throttle)",
    standard: StandardClass.Environmental,
  },
  {
    status: 404,
    code: "NoSuchUpload",
    label: "404 NoSuchUpload (re-plan path)",
    standard: StandardClass.Environmental,
  },
  // --- the GATES this refinement owes ---------------------------------------
  // Synthetic combinations: a control-plane `StaleUpload` 409 can never carry
  // the upload marker, and S3's own PUT 409 is `OperationAborted`. Driven anyway
  // because what has to hold is the GATE, not S3's catalogue — an ungated
  // refinement would read the environmental code here and freeze the budget on
  // the one status Appendix A's THIRD exception most wants laddered.
  {
    status: 409,
    code: "RequestTimeout",
    label:
      "409 carrying an environmental code (STATUS GATE: the refinement is scoped to 400/403)",
    standard: StandardClass.Item,
  },
  {
    status: 413,
    code: "RequestTimeout",
    label: "413 carrying an environmental code (STATUS GATE)",
    standard: StandardClass.Item,
  },
  // --- the hardwired defaults -----------------------------------------------
  {
    status: 400,
    code: "SomeFutureS3Code",
    label: "400 with a code no build here declares",
    standard: StandardClass.Environmental,
    coversUnknownCode: true,
  },
  {
    status: 403,
    code: "SomeFutureS3Code",
    label: "403 with a code no build here declares",
    standard: StandardClass.Environmental,
    coversUnknownCode: true,
  },
  {
    status: 400,
    label: "400 with a body that is not XML at all",
    standard: StandardClass.Environmental,
    rawBody: "not xml at all",
    coversUnknownCode: true,
  },
  {
    status: 400,
    label: "400 with an empty body",
    standard: StandardClass.Environmental,
    rawBody: "",
    coversUnknownCode: true,
  },
  // --- the ENVELOPE gate ----------------------------------------------------
  // A `<Code>` is only S3 speaking when it sits inside S3's `<Error>` envelope.
  // These two carry the strongest ITEM code there is, so an ungated parse reads
  // them ITEM, spends the row's budget five times and dead-letters a healthy
  // transcript — the loss shape this ticket removes, re-entered through a
  // truncated response or a proxy error page rather than through the status.
  {
    status: 400,
    label:
      "400 whose known ITEM code sits in a TRUNCATED envelope (ENVELOPE GATE)",
    standard: StandardClass.Environmental,
    rawBody: "<Error><Code>EntityTooLarge</Code>",
    coversUnknownCode: true,
  },
  {
    status: 400,
    label:
      "400 whose known ITEM code has no <Error> envelope at all (ENVELOPE GATE)",
    standard: StandardClass.Environmental,
    rawBody: "<Code>EntityTooLarge</Code>",
    coversUnknownCode: true,
  },
  {
    status: 418,
    label: "unrecognized status",
    standard: StandardClass.Environmental,
    rawBody: "",
    coversUnknownDefault: true,
  },
];

/** S3's error body for one code, in the shape S3 actually sends. */
function s3ErrorBody(cell: S3Cell): string {
  if (cell.rawBody !== undefined) {
    return cell.rawBody;
  }
  return `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${cell.code}</Code><Message>rejected</Message><RequestId>req-1</RequestId></Error>`;
}

/**
 * Drive one presigned upload through the REAL client and ask the SAME predicate
 * `transcript-drain-queue`'s `recordFailure` asks.
 *
 * It calls `isLaneWideTranscriptFailure` rather than re-composing its three
 * arms here. A hand-composed copy is a second oracle for one question: it stays
 * green while production drops an arm, which is the whole failure this
 * conformance file exists to catch. (Its `forbiddenCode` arm is inert on this
 * arm — only the CONTROL plane's 403 body sets that field — so including it
 * costs nothing and removing it would be the copy.)
 */
async function observeS3PutLane(cell: S3Cell): Promise<Observation> {
  let thrown: TranscriptSyncClientError;
  try {
    // The shared driver, not a third hand-rolled client: it already owns the
    // real-client construction, the `uploadPut` call and the typed-error
    // narrowing. It THROWS where this harness needs a returned `defect`, so the
    // catch below converts — a conversion, not a copy.
    thrown = await s3UploadError({
      status: cell.status,
      body: s3ErrorBody(cell),
    });
  } catch (error) {
    return {
      class: StandardClass.Environmental,
      defect: `the upload path did not reach a typed rejection: ${String(error)}`,
    };
  }
  if (thrown.s3Upload !== true) {
    return {
      class: StandardClass.Item,
      defect:
        "the client dropped the upload-arm marker, so no lane could tell this from a control-plane rejection",
    };
  }
  const laneWide = isLaneWideTranscriptFailure(thrown);
  return {
    class: laneWide ? StandardClass.Environmental : StandardClass.Item,
    defect: null,
  };
}

const LANES: readonly Lane<S3Cell>[] = [
  {
    name: "transcript S3 presigned PUT",
    cells: S3_PUT_CELLS,
    observe: observeS3PutLane,
  },
];

describe("PRD-699 Appendix A conformance — S3 presigned PUT", () => {
  registerLaneConformanceGuards(LANES);

  test("an unmapped or unreadable CODE at a refinable status takes the hardwired default", async () => {
    // Named separately from the shared unknown-STATUS guard because they are
    // different defaults: that one covers a status no branch names, this one a
    // status the refinement DOES own carrying a code it does not. Appendix A
    // hardwires both to ENVIRONMENTAL, and only this arm has the second.
    const cells = S3_PUT_CELLS.filter(
      (cell) => cell.coversUnknownCode === true
    );
    assert.ok(
      cells.length > 0,
      "the code-keyed default is unproven without at least one unmapped-code cell"
    );
    for (const cell of cells) {
      const observed = await observeS3PutLane(cell);
      assert.equal(observed.defect, null, cell.label);
      assert.equal(
        observed.class,
        StandardClass.Environmental,
        `${cell.label}: a code this build has never seen must never be guessed as the item's fault`
      );
    }
  });

  test("the ITEM side is what the refinement adds, and it is small on purpose", async () => {
    // The counterfactual for the whole arm. If every cell resolved
    // ENVIRONMENTAL the suite above would still pass while the lane had lost
    // its terminal door entirely, so the ITEM set is asserted to be non-empty
    // AND to be exactly what the table names.
    const itemLabels: string[] = [];
    for (const cell of S3_PUT_CELLS) {
      const observed = await observeS3PutLane(cell);
      if (observed.class === StandardClass.Item) {
        itemLabels.push(cell.label);
      }
    }
    assert.deepEqual(
      itemLabels.sort(),
      [
        "400 EntityTooLarge (an object S3 will never accept)",
        "400 KeyTooLongError (a key the desktop composed)",
        "409 carrying an environmental code (STATUS GATE: the refinement is scoped to 400/403)",
        "413 carrying an environmental code (STATUS GATE)",
      ].sort(),
      "exactly two content codes plus the two gate rows may keep the ladder; anything else is a widening nobody recorded"
    );
  });
});
