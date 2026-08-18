import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ImportZipDialog } from "../import-zip-dialog";

const mocks = vi.hoisted(() => ({
  importZip: vi.fn(),
  uploadIntent: vi.fn(),
  confirmUpload: vi.fn(),
  uploadToS3: vi.fn(),
}));

vi.mock("@repo/app/agents/hooks/use-catalog", () => ({
  useImportPackZip: () => ({
    isPending: false,
    mutateAsync: mocks.importZip,
  }),
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

const RE_OPEN = /^Open import$/;
const RE_UPLOAD = /^Upload Plugin bundle \(\.zip\)$/;
const RE_REPLACE = /^Replace Plugin bundle \(\.zip\)$/;
const RE_IMPORT = /^Import components$/;
const RE_DONE = /^Done$/;
const RE_SUMMARY = /Imported 2 components/;
const IMPORT_ERROR = "Zip is not a recognized Pack layout.";
const RE_ERROR = /Zip is not a recognized Pack layout\./;

/**
 * Mirrors PackComponentsPanel: the dialog is mounted unconditionally and its
 * `open` prop is driven by parent state, so any state the dialog holds outlives
 * a close unless the close path resets it.
 */
function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)} type="button">
        Open import
      </button>
      <ImportZipDialog
        onImported={vi.fn()}
        onOpenChange={setOpen}
        open={open}
        packId="pack-1"
      />
    </>
  );
}

async function uploadZip() {
  fireEvent.change(screen.getByLabelText(RE_UPLOAD), {
    target: {
      files: [new File(["zip"], "pack.zip", { type: "application/zip" })],
    },
  });
  await waitFor(() => expect(mocks.confirmUpload).toHaveBeenCalled());
}

async function runImport() {
  fireEvent.click(screen.getByRole("button", { name: RE_IMPORT }));
  await screen.findByText(RE_SUMMARY);
}

describe("ImportZipDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.importZip.mockResolvedValue({ created: 2, skipped: 0, invalid: 0 });
    mocks.uploadIntent.mockResolvedValue({
      presignedUrl: "https://s3.test/put",
      s3Key: "packs/pack-1.zip",
    });
    mocks.uploadToS3.mockResolvedValue(undefined);
    mocks.confirmUpload.mockResolvedValue({ id: "pack-1" });
  });

  // Done wired straight to the parent open-setter never runs the dialog's own
  // reset, so `result` survives the close and the reopened dialog shows the
  // previous import's success screen instead of a fresh upload form (FEA-3218).
  it("shows a fresh upload form after Done closes a successful import", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: RE_OPEN }));
    await uploadZip();
    await runImport();

    fireEvent.click(screen.getByRole("button", { name: RE_DONE }));
    await waitFor(() =>
      expect(screen.queryByText(RE_SUMMARY)).not.toBeInTheDocument()
    );

    fireEvent.click(screen.getByRole("button", { name: RE_OPEN }));

    expect(
      await screen.findByRole("button", { name: RE_IMPORT })
    ).toBeDisabled();
    expect(screen.queryByText(RE_SUMMARY)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: RE_DONE })
    ).not.toBeInTheDocument();
  });

  // The Esc/backdrop path reaches the same reset wrapper, so `uploaded`/`result`
  // must clear. The upload widget's own "uploaded successfully / Replace" step
  // is cleared by a different mechanism — Radix unmounts DialogContent, which
  // sits in a non-forceMount DialogPortal — so this also guards that assumption
  // against a future forceMount.
  it("shows a fresh upload form after Escape closes a successful import", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: RE_OPEN }));
    await uploadZip();
    await runImport();

    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByText(RE_SUMMARY)).not.toBeInTheDocument()
    );

    fireEvent.click(screen.getByRole("button", { name: RE_OPEN }));

    expect(
      await screen.findByRole("button", { name: RE_IMPORT })
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: RE_UPLOAD })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: RE_REPLACE })
    ).not.toBeInTheDocument();
    expect(screen.queryByText(RE_SUMMARY)).not.toBeInTheDocument();
  });

  // `reset()` clears `error` alongside `uploaded`/`result`; a failed import that
  // survived the close would strand the previous attempt's message on a freshly
  // reopened dialog, which is the same defect class as the stale success screen.
  it("clears a failed import's error message before the dialog reopens", async () => {
    mocks.importZip.mockRejectedValueOnce(new Error(IMPORT_ERROR));
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: RE_OPEN }));
    await uploadZip();

    fireEvent.click(screen.getByRole("button", { name: RE_IMPORT }));
    expect(await screen.findByText(RE_ERROR)).toBeInTheDocument();

    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByText(RE_ERROR)).not.toBeInTheDocument()
    );

    fireEvent.click(screen.getByRole("button", { name: RE_OPEN }));

    expect(
      await screen.findByRole("button", { name: RE_IMPORT })
    ).toBeDisabled();
    expect(screen.queryByText(RE_ERROR)).not.toBeInTheDocument();
  });
});
