/**
 * @file transcript-s3-upload-fixtures.ts
 * @description One driver for "what did the REAL client throw when S3 rejected a
 * presigned PUT".
 *
 * Extracted from `desktop-transcripts-client-retry-after.test.ts`, which grew the
 * first copy for ISS-8689 and is now a caller. ISS-8608 needed the same boundary
 * for a different question, and a second copy of the client construction plus the
 * `uploadPut`/`uploadPart` call plus the typed-error narrowing is the repeated
 * nontrivial fixture the root AGENTS.md says to extract rather than duplicate.
 *
 * `test/helpers/transcript-sync-executor-fixtures.ts` is NOT the home for this,
 * despite already exporting a `recordingClient()` with `uploadPut`/`uploadPart`:
 * that is a FAKE client, so it answers whatever the fake was told to. What both
 * callers here need is the real client's own body read running over a real
 * `Response`, which only a stubbed `fetch` behind `createDesktopTranscriptsClient`
 * can produce.
 */
import { Readable } from "node:stream";
import {
  createDesktopTranscriptsClient,
  TranscriptSyncClientError,
} from "../../src/main/transcript/desktop-transcripts-client.js";

/** The presigned URL shape the driver sends to; only its host is ever observed. */
const PRESIGNED_URL = "https://s3.test/presigned";

/** S3's canonical throttle body — the fixture ISS-8689 introduced. */
const S3_SLOW_DOWN_BODY = "<Error><Code>SlowDown</Code></Error>";

/** Which of the two presigned methods to drive. Both funnel through `put()`. */
type S3UploadArm = "fullPut" | "part";

/**
 * Drive one presigned upload against a canned S3 response and return the typed
 * error the real client threw.
 *
 * Throws rather than returning a sentinel when the client resolves or throws
 * something else: a driver that swallowed that would let a caller assert against
 * a fabricated error while the production path had stopped throwing at all.
 */
export async function s3UploadError(options: {
  status?: number;
  body?: string | null;
  headers?: Record<string, string>;
  arm?: S3UploadArm;
  /** Simulates a body that cannot be read at all, not merely an empty one. */
  bodyUnreadable?: boolean;
}): Promise<TranscriptSyncClientError> {
  const status = options.status ?? 503;
  const arm = options.arm ?? "fullPut";
  const response = new Response(
    options.body === undefined ? S3_SLOW_DOWN_BODY : options.body,
    { status, headers: options.headers ?? {} }
  );
  if (options.bodyUnreadable === true) {
    Object.defineProperty(response, "text", {
      value: () => Promise.reject(new Error("body stream already consumed")),
    });
  }
  const client = createDesktopTranscriptsClient({
    fetch: () =>
      Promise.resolve(response) as unknown as ReturnType<typeof fetch>,
    getAccessToken: () => Promise.resolve("token"),
    getApiOrigin: () => "https://api.test",
  });
  try {
    if (arm === "part") {
      await client.uploadPart(PRESIGNED_URL, Readable.from(["bytes"]), 5);
    } else {
      await client.uploadPut(
        PRESIGNED_URL,
        Readable.from(["bytes"]),
        5,
        "crc64"
      );
    }
  } catch (error) {
    if (error instanceof TranscriptSyncClientError) {
      return error;
    }
    throw new Error(
      `the upload path must throw its own typed error, got ${String(error)}`
    );
  }
  throw new Error(`${arm} resolved on an HTTP ${status}`);
}
