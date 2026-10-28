/**
 * @file desktop-transcripts-client-s3-error-code.test.ts
 * @description ISS-8608 (PRD-699 Appendix A exception 4 / F6): the client lifts
 * S3's XML error `<Code>` onto the error it throws, so the drain can tell an
 * expired presign from an object S3 will never accept.
 *
 * This suite drives the REAL client over a stubbed `fetch`, for the reason its
 * two siblings give: constructing a `TranscriptSyncClientError` with the fields
 * by hand — which the drain tests do — leaves the PRODUCTION wiring unasserted.
 * Delete the body read from `put` and every one of those stays green while the
 * desktop is back to classifying a presign expiry as the file's own fault.
 *
 * It is also the ONLY place the "parse the code BEFORE the snippet transforms"
 * decision can be pinned. Every classification fixture elsewhere uses a short,
 * well-formed body, so moving the match after the whitespace collapse and the
 * 500-character cut would leave the whole rest of the suite green.
 *
 * THE FIRST THREE CASES ARE LOCKS ON BEHAVIOUR THIS TICKET DID NOT CHANGE.
 * A Stryker run over `desktop-transcripts-client.ts` before any edit scored
 * 54.64% with survivors at the exact snippet lines this change restructures
 * (the body read, the whitespace collapse, the 500-char cut, and the no-detail
 * branch). Nothing pinned them, so a restructure could have altered the message
 * silently. They were written and run against unmodified `main` first, so the
 * only expectation that moves in this commit is the one the ticket is about.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { test } from "vitest";
import {
  createDesktopTranscriptsClient,
  TranscriptSyncClientError,
} from "../src/main/transcript/desktop-transcripts-client.js";
import { s3UploadError } from "./helpers/transcript-s3-upload-fixtures.js";

/** The snippet the client folds into the message, isolated from the prefix. */
const DETAIL_SEPARATOR = ": ";
/** How long the snippet may be, per the client's own cut. */
const DETAIL_MAX_CHARS = 500;

// ---------------------------------------------------------------------------
// Locks on the pre-existing snippet behaviour — see the file header.
// ---------------------------------------------------------------------------

test("LOCK: runs of whitespace in the S3 body collapse to single spaces", async () => {
  const error = await s3UploadError({
    status: 400,
    body: "<Error>\n\n   <Code>EntityTooLarge</Code>\t\t<Message>too   big</Message>\n</Error>",
  });

  const detail = error.message.slice(
    error.message.indexOf(DETAIL_SEPARATOR) + DETAIL_SEPARATOR.length
  );
  assert.equal(
    detail,
    "<Error> <Code>EntityTooLarge</Code> <Message>too big</Message> </Error>",
    "the snippet is one line so a log reader sees the whole rejection at once"
  );
});

test("LOCK: an S3 body longer than the cut is truncated to it", async () => {
  const error = await s3UploadError({
    status: 400,
    body: `<Error><Message>${"z".repeat(2000)}</Message></Error>`,
  });

  const detail = error.message.slice(
    error.message.indexOf(DETAIL_SEPARATOR) + DETAIL_SEPARATOR.length
  );
  assert.equal(
    detail.length,
    DETAIL_MAX_CHARS,
    "an unbounded S3 body must not become an unbounded lastError on the row"
  );
});

test("LOCK: an empty S3 body leaves the message status-only, with no dangling separator", async () => {
  const error = await s3UploadError({ status: 400, body: "" });

  assert.equal(
    error.message,
    "transcript fullPut returned HTTP 400",
    "no body means no snippet clause at all, not an empty one"
  );
});

// ---------------------------------------------------------------------------
// ISS-8608: the code, and the arm that produced it.
// ---------------------------------------------------------------------------

test("ISS-8608: a well-formed S3 rejection carries both the arm marker and the code", async () => {
  const error = await s3UploadError({
    status: 403,
    body: '<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>ExpiredToken</Code><Message>The provided token has expired.</Message></Error>',
  });

  assert.equal(
    error.status,
    403,
    "the status still routes what the code cannot"
  );
  assert.equal(
    error.s3Upload,
    true,
    "the ARM marker is what separates this from a control-plane 403"
  );
  assert.equal(error.s3ErrorCode, "ExpiredToken");
});

test("ISS-8608: the code is read BEFORE the 500-character cut, not after", async () => {
  // S3 puts `<Message>` beside `<Code>`, and a verbose one pushes the code past
  // the snippet cut. A parse that ran on the truncated snippet would return
  // undefined here and silently classify an expired presign as unreadable — the
  // mutation this case exists to kill.
  const error = await s3UploadError({
    status: 403,
    body: `<Error><Message>${"z".repeat(900)}</Message><Code>ExpiredToken</Code></Error>`,
  });

  assert.equal(
    error.s3ErrorCode,
    "ExpiredToken",
    "a code beyond the snippet cut is still the code S3 sent"
  );
});

test("ISS-8608: the code is read BEFORE the whitespace collapse, not after", async () => {
  const error = await s3UploadError({
    status: 400,
    body: "<Error>\n  <Code>\n    RequestTimeout\n  </Code>\n</Error>",
  });

  assert.equal(
    error.s3ErrorCode,
    "RequestTimeout",
    "S3 pretty-printing its XML must not cost the discriminator"
  );
});

test("ISS-8608: the first <Code> wins when a body carries more than one", async () => {
  // S3's contract puts `<Code>` as the first child of `<Error>`. Pinned so the
  // rule is a decision on the record rather than an accident of the regex.
  const error = await s3UploadError({
    status: 400,
    body: "<Error><Code>EntityTooLarge</Code><Message><Code>ExpiredToken</Code></Message></Error>",
  });

  assert.equal(error.s3ErrorCode, "EntityTooLarge");
});

test("ISS-8608: a code longer than the cap is not captured", async () => {
  const error = await s3UploadError({
    status: 400,
    body: `<Error><Code>${"A".repeat(129)}</Code></Error>`,
  });

  assert.equal(
    error.s3ErrorCode,
    undefined,
    "an unbounded capture off an unbounded body is what the cap exists to refuse"
  );
  assert.equal(error.s3Upload, true, "and the arm is still known");
});

test("ISS-8608: a code carrying characters outside the class is not captured", async () => {
  const error = await s3UploadError({
    status: 400,
    body: "<Error><Code>Entity Too<Large</Code></Error>",
  });

  assert.equal(error.s3ErrorCode, undefined);
});

test("ISS-8608: a prototype key arrives as an ordinary string", async () => {
  // The captured value is looked up in a table. Carried as a plain string here;
  // that the LOOKUP answers it safely is `transcript-sync-types`' contract, and
  // is asserted there.
  const error = await s3UploadError({
    status: 400,
    body: "<Error><Code>__proto__</Code></Error>",
  });

  assert.equal(error.s3ErrorCode, "__proto__");
});

test("ISS-8608: an unreadable body still yields the arm marker and the status", async () => {
  const error = await s3UploadError({
    status: 400,
    body: "<Error><Code>EntityTooLarge</Code></Error>",
    bodyUnreadable: true,
  });

  assert.equal(error.status, 400);
  assert.equal(
    error.s3Upload,
    true,
    "the marker is what lets an unreadable S3 400 be told from a control-plane 400"
  );
  assert.equal(error.s3ErrorCode, undefined);
});

test("ISS-8608: a body with no XML at all yields the arm marker and no code", async () => {
  const error = await s3UploadError({ status: 400, body: "not xml at all" });

  assert.equal(error.s3Upload, true);
  assert.equal(error.s3ErrorCode, undefined);
});

// ---------------------------------------------------------------------------
// ISS-8608: the `<Error>` envelope gate.
//
// The ticket's acceptance criterion puts MALFORMED XML on the environmental
// side, and only an ITEM code costs the row its retry budget. So the dangerous
// input is not a body with no code — it is a MALFORMED body carrying the
// strongest ITEM code there is: an ungated parse reads it ITEM, spends five
// attempts and dead-letters a healthy transcript through a truncated response
// or a proxy error page. The positive case below is what keeps the two
// refusals from being vacuous.
// ---------------------------------------------------------------------------

test("ISS-8608: a known ITEM code in a TRUNCATED envelope is not captured", async () => {
  const error = await s3UploadError({
    status: 400,
    body: "<Error><Code>EntityTooLarge</Code>",
  });

  assert.equal(
    error.s3ErrorCode,
    undefined,
    "an unterminated envelope is malformed XML, which the AC puts on the environmental side"
  );
  assert.equal(error.s3Upload, true, "and the arm is still known");
});

test("ISS-8608: a known ITEM code with no <Error> envelope at all is not captured", async () => {
  const error = await s3UploadError({
    status: 400,
    body: "<Code>EntityTooLarge</Code>",
  });

  assert.equal(
    error.s3ErrorCode,
    undefined,
    "a bare <Code> is not S3 speaking; only the envelope makes it S3's own verdict"
  );
});

test("ISS-8608: the SAME ITEM code in a well-formed envelope IS captured", async () => {
  // The counterfactual for the two refusals above. Without it both stay green
  // if `EntityTooLarge` stopped being captured at all, and the ITEM ladder — the
  // only terminal door an unsendable object has — would be silently gone.
  const error = await s3UploadError({
    status: 400,
    body: "<Error><Code>EntityTooLarge</Code></Error>",
  });

  assert.equal(error.s3ErrorCode, "EntityTooLarge");
});

test("ISS-8608: the multipart arm carries the marker too", async () => {
  // The motivating failure is a socket that stalls MID-PART, so the arm the
  // ticket is about must be the arm that is driven.
  const error = await s3UploadError({
    status: 400,
    body: "<Error><Code>IncompleteBody</Code></Error>",
    arm: "part",
  });

  assert.equal(error.s3Upload, true);
  assert.equal(error.s3ErrorCode, "IncompleteBody");
});

test("ISS-8608: a CONTROL-plane rejection acquires neither field, even carrying a <Code>", async () => {
  // The arm marker's whole job. `postControl` and `put` both throw the same
  // class, and only the second may have its 400 re-read as environmental — so a
  // control response that happens to contain the element must not leak across.
  const client = createDesktopTranscriptsClient({
    fetch: () =>
      Promise.resolve(
        new Response("<Error><Code>ExpiredToken</Code></Error>", {
          status: 400,
        })
      ) as unknown as ReturnType<typeof fetch>,
    getAccessToken: () => Promise.resolve("token"),
    getApiOrigin: () => "https://api.test",
  });
  let thrown: unknown;
  try {
    await client.syncPlan({
      computeTargetId: "ct-1",
      externalSessionId: "sess-1",
      fileKey: "main",
      sourceHarness: "claude",
      sourcePathHash: "hash-1",
      sourceMtime: 1000,
      planEndOffset: 100,
    } as never);
  } catch (error) {
    thrown = error;
  }

  assert.ok(thrown instanceof TranscriptSyncClientError);
  assert.equal(thrown.status, 400);
  assert.equal(
    thrown.s3Upload,
    undefined,
    "only the presigned arm may mark itself, or a control 400 stops dead-lettering"
  );
  assert.equal(thrown.s3ErrorCode, undefined);
});

test("ISS-8608: the S3 code and ISS-8689's Retry-After coexist without displacing each other", async () => {
  const error = await s3UploadError({
    status: 403,
    body: "<Error><Code>ExpiredToken</Code></Error>",
    headers: { "Retry-After": "3600" },
  });

  assert.equal(error.retryAfterMs, 3_600_000, "the older field survives");
  assert.equal(error.s3ErrorCode, "ExpiredToken", "and the newer one is set");
  assert.equal(error.s3Upload, true);
});

test("ISS-8608: a REAL streaming PUT to a server that rejects mid-body still yields the code", async () => {
  // Everything above stubs `fetch` with a ready `Response`, which cannot tell
  // "S3 answered 403 and we parsed the code" from "undici errored the streaming
  // request and we took the status-less throw" — and if the second is what
  // production does, this whole change is inert. So drive the real client, over
  // the real `duplex: "half"` streaming path, against a real loopback server
  // that answers 403 WITHOUT consuming the request body.
  const server = createServer((_request, response) => {
    response.writeHead(403, { "Content-Type": "application/xml" });
    response.end(
      "<Error><Code>ExpiredToken</Code><Message>The provided token has expired.</Message></Error>"
    );
  });
  try {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address() as AddressInfo;
    const client = createDesktopTranscriptsClient({
      getAccessToken: () => Promise.resolve("token"),
      getApiOrigin: () => "https://api.test",
    });
    let thrown: unknown;
    try {
      await client.uploadPut(
        `http://127.0.0.1:${port}/presigned`,
        Readable.from([Buffer.alloc(64 * 1024, 0x61)]),
        64 * 1024,
        "crc64"
      );
    } catch (error) {
      thrown = error;
    }

    assert.ok(
      thrown instanceof TranscriptSyncClientError,
      `the real upload path must throw its typed error, got ${String(thrown)}`
    );
    assert.equal(
      thrown.status,
      403,
      "an early rejection reaches the status arm, not the status-less transport arm"
    );
    assert.equal(
      thrown.s3ErrorCode,
      "ExpiredToken",
      "and the code survives the streaming request, which is what makes the fix reachable at all"
    );
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
});
