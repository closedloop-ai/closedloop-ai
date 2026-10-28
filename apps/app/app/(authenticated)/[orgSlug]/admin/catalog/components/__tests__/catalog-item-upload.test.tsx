/**
 * ISS-6694: the three-step presigned upload, composed.
 *
 * `packages/app/agents/hooks/__tests__/use-catalog.test.tsx` already covers
 * `useUploadIntent` and `useConfirmUpload` in isolation. What nothing covered is
 * the COMPOSITION this component owns: that step 2 receives what step 1
 * returned and step 3 receives what step 2 was handed. So the assertions here
 * are deliberately hand-off shaped —
 *
 *  - the intent request is derived from the real `File` (type, size), not a
 *    literal;
 *  - two consecutive uploads get two DIFFERENT presigned URL / s3Key pairs, so
 *    a component that hardcoded either value, or reused the first upload's key,
 *    fails the second run;
 *  - `uploadToS3` receives the same `File` object identity that was selected;
 *  - each in-flight step is observed by its own progress label WHILE the next
 *    step has provably not been called yet, which is what makes the ordering
 *    claim real rather than an artifact of all three mocks resolving.
 *
 * Asserting only the final "uploaded successfully" line would pass under a
 * dropped `s3Key`, a swapped URL, or a reordered flow — the false green the
 * ticket names.
 */

import type { CatalogItemDto } from "@repo/api/src/types/distribution";
import {
  CatalogItemScope,
  CatalogItemSource,
} from "@repo/api/src/types/distribution";
import type {
  ConfirmUploadRequest,
  UploadIntentRequest,
  UploadIntentResponse,
} from "@repo/app/agents/hooks/use-catalog";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CatalogItemUpload } from "../catalog-item-upload";

const mocks = vi.hoisted(() => ({
  uploadIntent: vi.fn(),
  confirmUpload: vi.fn(),
  uploadToS3: vi.fn(),
}));

vi.mock("@repo/app/agents/hooks/use-catalog", () => ({
  useUploadIntent: () => ({
    isPending: false,
    mutateAsync: mocks.uploadIntent,
  }),
  useConfirmUpload: () => ({
    isPending: false,
    mutateAsync: mocks.confirmUpload,
  }),
}));

vi.mock("@repo/app/shared/lib/s3-upload", () => ({
  uploadToS3: mocks.uploadToS3,
}));

const CATALOG_ITEM_ID = "catalog-item-1";
const ZIP_MIME = "application/zip";
const OCTET_STREAM = "application/octet-stream";

/** Two distinct intent responses — the whole point of the threading test. */
const PRESIGNED_URL_A = "https://s3.test/put/a?sig=aaa";
const PRESIGNED_URL_B = "https://s3.test/put/b?sig=bbb";
const S3_KEY_A = "org-1/catalog-item-1/first.zip";
const S3_KEY_B = "org-1/catalog-item-1/second.zip";

const INTENT_LABEL = "Requesting upload URL…";
const S3_LABEL = "Uploading to storage…";
const CONFIRM_LABEL = "Verifying upload…";
const DONE_TEXT = "Plugin bundle (.zip) uploaded successfully.";
const FALLBACK_ERROR = "Upload failed";

const UPLOAD_ZIP_BUTTON_TEXT = "Upload Plugin bundle (.zip)";
const RE_UPLOAD_ZIP = /^Upload Plugin bundle \(\.zip\)$/;
const RE_REPLACE_ZIP = /^Replace Plugin bundle \(\.zip\)$/;
const RE_UPLOAD_LOGO = /^Upload Logo image$/;

const INTENT_ERROR = "No presigned URL available.";
const S3_ERROR = "S3 upload failed: 403 Forbidden";
const CONFIRM_ERROR = "Object not found in storage.";

const updatedItem: CatalogItemDto = {
  id: CATALOG_ITEM_ID,
  organizationId: "org-1",
  targetKind: "pack",
  source: CatalogItemSource.OrgCustom,
  scope: CatalogItemScope.Org,
  name: "Custom Pack",
  description: null,
  version: "1.0.0",
  sortOrder: 0,
  enabled: true,
  archived: false,
  coaching: false,
  coachingConfig: null,
  parentPackId: null,
  componentUuid: null,
  content: null,
  components: [],
  agentSlug: null,
  logoUrl: null,
  createdById: "owner-1",
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function zipFile(name: string, contents: string): File {
  return new File([contents], name, { type: ZIP_MIME });
}

function selectFile(file: File, matcher: RegExp = RE_UPLOAD_ZIP): void {
  fireEvent.change(screen.getByLabelText(matcher), {
    target: { files: [file] },
  });
}

/** Let the component's awaited chain advance past a settled step. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function renderZipUpload(onSuccess?: (item: CatalogItemDto) => void) {
  return render(
    <CatalogItemUpload
      catalogItemId={CATALOG_ITEM_ID}
      fileType="zip"
      onSuccess={onSuccess}
    />
  );
}

function intentCall(index: number): UploadIntentRequest {
  return mocks.uploadIntent.mock.calls[index][0] as UploadIntentRequest;
}

function confirmCall(index: number): ConfirmUploadRequest {
  return mocks.confirmUpload.mock.calls[index][0] as ConfirmUploadRequest;
}

function s3Call(index: number): [string, File, string] {
  return mocks.uploadToS3.mock.calls[index] as [string, File, string];
}

/**
 * Explicit, not inherited: the first case in this file pays the tree's
 * first-mount cost in jsdom and lands close to vitest's 5s default. Nothing
 * here waits on elapsed time — every assertion resolves on a rendered node or a
 * recorded mock call — so the ceiling bounds a genuine hang rather than hiding
 * one.
 */
const SUITE_TIMEOUT_MS = 30_000;

describe(
  "CatalogItemUpload",
  () => {
    beforeEach(() => {
      vi.clearAllMocks();
      mocks.uploadIntent.mockResolvedValue({
        presignedUrl: PRESIGNED_URL_A,
        s3Key: S3_KEY_A,
      } satisfies UploadIntentResponse);
      mocks.uploadToS3.mockResolvedValue(undefined);
      mocks.confirmUpload.mockResolvedValue(updatedItem);
    });

    // The ordering claim: each label is observed while its own step is still
    // in flight AND the next step has not been called. All three mocks resolving
    // would satisfy a final-text-only assertion no matter what order they ran in.
    it("shows each step's progress label while that step is in flight, and starts the next step only after the previous one settles", async () => {
      const intent = deferred<UploadIntentResponse>();
      const s3 = deferred<void>();
      const confirm = deferred<CatalogItemDto>();
      mocks.uploadIntent.mockReturnValue(intent.promise);
      mocks.uploadToS3.mockReturnValue(s3.promise);
      mocks.confirmUpload.mockReturnValue(confirm.promise);
      const onSuccess = vi.fn();

      renderZipUpload(onSuccess);
      selectFile(zipFile("pack.zip", "zip-bytes"));

      expect(await screen.findByText(INTENT_LABEL)).toBeInTheDocument();
      expect(mocks.uploadToS3).not.toHaveBeenCalled();
      expect(mocks.confirmUpload).not.toHaveBeenCalled();

      intent.resolve({ presignedUrl: PRESIGNED_URL_A, s3Key: S3_KEY_A });
      expect(await screen.findByText(S3_LABEL)).toBeInTheDocument();
      expect(screen.queryByText(INTENT_LABEL)).not.toBeInTheDocument();
      expect(mocks.uploadToS3).toHaveBeenCalledTimes(1);
      expect(mocks.confirmUpload).not.toHaveBeenCalled();

      s3.resolve();
      expect(await screen.findByText(CONFIRM_LABEL)).toBeInTheDocument();
      expect(screen.queryByText(S3_LABEL)).not.toBeInTheDocument();
      expect(mocks.confirmUpload).toHaveBeenCalledTimes(1);
      expect(onSuccess).not.toHaveBeenCalled();

      confirm.resolve(updatedItem);
      expect(await screen.findByText(DONE_TEXT)).toBeInTheDocument();
      expect(onSuccess).toHaveBeenCalledWith(updatedItem);
      expect(
        screen.getByRole("button", { name: RE_REPLACE_ZIP })
      ).toBeInTheDocument();
    });

    // Step 1 → step 2 → step 3 hand-off. Two runs with DIFFERENT intent responses:
    // a hardcoded URL or s3Key, or a component that reused run 1's key, reddens on
    // the second run. `toBe` on the File proves the selected file itself is what
    // reaches S3, not a re-read or a different entry in the FileList.
    it("threads each step's output into the next across consecutive uploads", async () => {
      mocks.uploadIntent
        .mockResolvedValueOnce({
          presignedUrl: PRESIGNED_URL_A,
          s3Key: S3_KEY_A,
        })
        .mockResolvedValueOnce({
          presignedUrl: PRESIGNED_URL_B,
          s3Key: S3_KEY_B,
        });

      renderZipUpload();

      const firstFile = zipFile("first.zip", "first-bytes");
      selectFile(firstFile);
      await waitFor(() => expect(mocks.confirmUpload).toHaveBeenCalledTimes(1));

      expect(s3Call(0)[0]).toBe(PRESIGNED_URL_A);
      expect(s3Call(0)[1]).toBe(firstFile);
      expect(s3Call(0)[2]).toBe(ZIP_MIME);
      expect(confirmCall(0)).toEqual({
        catalogItemId: CATALOG_ITEM_ID,
        fileType: "zip",
        s3Key: S3_KEY_A,
      });

      const secondFile = zipFile("second.zip", "second-bytes-longer");
      fireEvent.click(screen.getByRole("button", { name: RE_REPLACE_ZIP }));
      selectFile(secondFile);
      await waitFor(() => expect(mocks.confirmUpload).toHaveBeenCalledTimes(2));

      expect(s3Call(1)[0]).toBe(PRESIGNED_URL_B);
      expect(s3Call(1)[1]).toBe(secondFile);
      expect(confirmCall(1)).toEqual({
        catalogItemId: CATALOG_ITEM_ID,
        fileType: "zip",
        s3Key: S3_KEY_B,
      });
    });

    // The intent body is derived from the File, not from props alone: a
    // hardcoded size or MIME type reddens because both are read off the instance
    // the test created.
    it("derives the intent request from the selected File", async () => {
      renderZipUpload();

      // A MIME Windows browsers really send for a .zip, deliberately NOT the
      // component's own "zip" fileType string: a hardcoded `application/zip`
      // would satisfy a fixture that used the obvious value.
      const file = new File(["some-zip-bytes"], "pack.zip", {
        type: "application/x-zip-compressed",
      });
      selectFile(file);
      await waitFor(() => expect(mocks.uploadIntent).toHaveBeenCalledTimes(1));

      expect(intentCall(0)).toEqual({
        catalogItemId: CATALOG_ITEM_ID,
        fileType: "zip",
        contentType: file.type,
        fileSizeBytes: file.size,
      });
      expect(file.size).toBeGreaterThan(0);
    });

    // A browser hands over a typeless File for an unrecognized extension. The
    // fallback must reach BOTH the intent body and the S3 PUT's Content-Type — a
    // presigned URL signed for one type and PUT with another is rejected by S3.
    it("falls back to application/octet-stream for a File with no type, in both the intent and the S3 PUT", async () => {
      renderZipUpload();

      const typeless = new File(["bytes"], "mystery.bin", { type: "" });
      selectFile(typeless);
      await waitFor(() => expect(mocks.confirmUpload).toHaveBeenCalled());

      expect(intentCall(0).contentType).toBe(OCTET_STREAM);
      expect(s3Call(0)[2]).toBe(OCTET_STREAM);
    });

    it("passes the logo fileType through to both steps", async () => {
      render(
        <CatalogItemUpload catalogItemId={CATALOG_ITEM_ID} fileType="logo" />
      );

      selectFile(
        new File(["png"], "logo.png", { type: "image/png" }),
        RE_UPLOAD_LOGO
      );
      await waitFor(() => expect(mocks.confirmUpload).toHaveBeenCalled());

      expect(intentCall(0).fileType).toBe("logo");
      expect(confirmCall(0).fileType).toBe("logo");
    });

    it("stops at step 1 and reports the intent failure without touching S3 or confirm", async () => {
      mocks.uploadIntent.mockRejectedValueOnce(new Error(INTENT_ERROR));
      const onSuccess = vi.fn();

      renderZipUpload(onSuccess);
      selectFile(zipFile("pack.zip", "zip-bytes"));

      expect(await screen.findByText(INTENT_ERROR)).toBeInTheDocument();
      expect(mocks.uploadToS3).not.toHaveBeenCalled();
      expect(mocks.confirmUpload).not.toHaveBeenCalled();
      expect(onSuccess).not.toHaveBeenCalled();
      expect(
        screen.getByRole("button", { name: RE_UPLOAD_ZIP })
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: RE_REPLACE_ZIP })
      ).not.toBeInTheDocument();
    });

    it("stops at step 2 and reports the S3 failure without confirming", async () => {
      mocks.uploadToS3.mockRejectedValueOnce(new Error(S3_ERROR));
      const onSuccess = vi.fn();

      renderZipUpload(onSuccess);
      selectFile(zipFile("pack.zip", "zip-bytes"));

      expect(await screen.findByText(S3_ERROR)).toBeInTheDocument();
      expect(mocks.uploadIntent).toHaveBeenCalledTimes(1);
      expect(mocks.confirmUpload).not.toHaveBeenCalled();
      expect(onSuccess).not.toHaveBeenCalled();
      expect(
        screen.getByRole("button", { name: RE_UPLOAD_ZIP })
      ).toBeInTheDocument();
    });

    // Step 3 failing must NOT read as success: the S3 object exists but the
    // server never verified it, so `onSuccess` must not fire and the button must
    // not flip to "Replace".
    it("reports a confirm failure after the bytes are already in S3, and does not claim success", async () => {
      mocks.confirmUpload.mockRejectedValueOnce(new Error(CONFIRM_ERROR));
      const onSuccess = vi.fn();

      renderZipUpload(onSuccess);
      selectFile(zipFile("pack.zip", "zip-bytes"));

      expect(await screen.findByText(CONFIRM_ERROR)).toBeInTheDocument();
      expect(mocks.uploadToS3).toHaveBeenCalledTimes(1);
      expect(onSuccess).not.toHaveBeenCalled();
      expect(screen.queryByText(DONE_TEXT)).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: RE_REPLACE_ZIP })
      ).not.toBeInTheDocument();
    });

    it("renders the generic message when a step rejects with a non-Error value", async () => {
      mocks.uploadIntent.mockRejectedValueOnce("boom");

      renderZipUpload();
      selectFile(zipFile("pack.zip", "zip-bytes"));

      expect(await screen.findByText(FALLBACK_ERROR)).toBeInTheDocument();
    });

    // "No mutation fired" is NOT enough on its own: dropping the `!file` guard
    // also fires nothing, because reading `file.type` throws first — it just
    // paints a TypeError into the destructive slot, and the button reads
    // "Upload …" in the error state exactly as it does when idle. So the load-
    // bearing assertion is that the component rendered NO text beyond the
    // button — asserted on content, not on a wrapper tag, so moving the message
    // into an Alert cannot silently stop it from matching.
    it("does nothing when the change event carries no file", async () => {
      const { container } = renderZipUpload();

      fireEvent.change(screen.getByLabelText(RE_UPLOAD_ZIP), {
        target: { files: [] },
      });
      await flush();

      expect(mocks.uploadIntent).not.toHaveBeenCalled();
      expect(screen.queryByText(INTENT_LABEL)).not.toBeInTheDocument();
      expect(container.textContent).toBe(UPLOAD_ZIP_BUTTON_TEXT);
      expect(
        screen.getByRole("button", { name: RE_UPLOAD_ZIP })
      ).toBeInTheDocument();
    });
  },
  SUITE_TIMEOUT_MS
);
