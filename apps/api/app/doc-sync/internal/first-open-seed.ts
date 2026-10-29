import { log } from "@repo/observability/log";
import { FirstOpenSeedState } from "@repo/realtime-contract/doc-sync-internal";
import { generateDocumentRoomId } from "@repo/realtime-contract/document-room";
import { isTimeoutError, withTimeout } from "@/lib/with-timeout";
import { documentVersionService } from "../../documents/document-version-service";
import { docSyncInternalClient } from "./internal-client";

export type FirstOpenSeedDocument = {
  organizationId: string;
  slug: string;
  documentId: string;
};

/**
 * ISS-12508 (PLN-2229 T-3.2): seeds a never-stored document from its latest
 * version before its token is returned. A stored document costs one indexed
 * read in doc-sync, and the latest version is read only for a document that
 * needs a seed, or whose probe failed. One deadline,
 * {@link DOC_SYNC_FIRST_OPEN_SEED_TIMEOUT_MS}, bounds the whole helper, nothing
 * is retried, and it never throws: the token is issued whatever it meets
 * (PLN-2229 A-1).
 *
 * `Unconfirmed` when the document has a latest version with content that the
 * helper could not confirm is in the live document, so the editor can show an
 * error rather than an empty document (PLN-2229 OQ-3, Kerensa Whitlock 2026-10-23).
 */
export async function seedLatestVersionOnFirstOpen(
  { organizationId, slug, documentId }: FirstOpenSeedDocument,
  now: () => number = Date.now
): Promise<FirstOpenSeedOutcome> {
  const deadline = now() + DOC_SYNC_FIRST_OPEN_SEED_TIMEOUT_MS;
  const timeLeft = () => Math.max(0, deadline - now());
  try {
    const roomId = generateDocumentRoomId(organizationId, slug);
    const client = docSyncInternalClient();
    const probe = await client.probeFirstOpenSeed(roomId, {
      timeoutMs: timeLeft(),
    });
    if (probe.ok && probe.value.state !== FirstOpenSeedState.NeedsSeed) {
      return FirstOpenSeedOutcome.Confirmed;
    }
    const latest = await readLatestVersion(documentId, timeLeft());
    if (latest === LATEST_VERSION_TIMED_OUT) {
      return FirstOpenSeedOutcome.Unconfirmed;
    }
    if (!latest?.content?.trim()) {
      return FirstOpenSeedOutcome.Confirmed;
    }
    const timeoutMs = timeLeft();
    if (!probe.ok || timeoutMs === 0) {
      return FirstOpenSeedOutcome.Unconfirmed;
    }
    const applied = await client.seedIfNeverStored(
      roomId,
      { markdown: latest.content, version: latest.version },
      { timeoutMs }
    );
    return applied.ok
      ? FirstOpenSeedOutcome.Confirmed
      : FirstOpenSeedOutcome.Unconfirmed;
  } catch (error) {
    log.error("Doc sync first-open seed failed", {
      event: DOC_SYNC_FIRST_OPEN_SEED_FAILED_EVENT,
      organizationId,
      documentId,
      code: error instanceof Error ? error.name : typeof error,
    });
    return FirstOpenSeedOutcome.Unconfirmed;
  }
}

/**
 * `Confirmed`: the document was stored, seeded, or has no content to seed.
 * An apply that answers `applied: false` is confirmed too: the service found
 * the document stored or changed since its load.
 */
export const FirstOpenSeedOutcome = {
  Confirmed: "confirmed",
  Unconfirmed: "unconfirmed",
} as const;
export type FirstOpenSeedOutcome =
  (typeof FirstOpenSeedOutcome)[keyof typeof FirstOpenSeedOutcome];

/** On every token mint and reconnect, so below the client's per-call default (PLN-2229 Implementation Notes). */
export const DOC_SYNC_FIRST_OPEN_SEED_TIMEOUT_MS = 3000;

export const DOC_SYNC_FIRST_OPEN_SEED_FAILED_EVENT =
  "doc_sync.first_open_seed_failed";

const LATEST_VERSION_READ_LABEL = "Doc sync first-open latest version read";

const LATEST_VERSION_TIMED_OUT = Symbol("latest version read timed out");

type LatestVersion = Awaited<
  ReturnType<typeof documentVersionService.getLatest>
>;

function readLatestVersion(
  documentId: string,
  timeoutMs: number
): Promise<LatestVersion | typeof LATEST_VERSION_TIMED_OUT> {
  if (timeoutMs === 0) {
    return Promise.resolve(LATEST_VERSION_TIMED_OUT);
  }
  return withTimeout(
    documentVersionService.getLatest(documentId),
    timeoutMs,
    LATEST_VERSION_READ_LABEL
  ).catch((error: unknown) => {
    if (isTimeoutError(error, LATEST_VERSION_READ_LABEL)) {
      return LATEST_VERSION_TIMED_OUT;
    }
    throw error;
  });
}
