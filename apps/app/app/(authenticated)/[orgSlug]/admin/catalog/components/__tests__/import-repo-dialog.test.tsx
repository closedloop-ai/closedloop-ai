import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ImportRepoDialog } from "../import-repo-dialog";

const mocks = vi.hoisted(() => ({
  importRepo: vi.fn(),
}));

vi.mock("@repo/app/agents/hooks/use-catalog", () => ({
  useImportPackRepo: () => ({
    isPending: false,
    mutateAsync: mocks.importRepo,
  }),
}));

const RE_REPO = /Repository/;
const RE_SUMMARY_WITH_INVALID =
  /Imported 3 components, skipped 1 already present, dropped 2 invalid/;
const RE_SUMMARY_CLEAN = /Imported 2 components/;
const RE_INVALID = /invalid/;

async function importFrom(result: {
  created: number;
  skipped: number;
  invalid: number;
}) {
  mocks.importRepo.mockResolvedValue(result);
  render(
    <ImportRepoDialog
      onImported={vi.fn()}
      onOpenChange={vi.fn()}
      open={true}
      packId="pack-1"
    />
  );
  fireEvent.change(screen.getByLabelText(RE_REPO), {
    target: { value: "acme/shared-assets" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Import components" }));
  await waitFor(() => expect(mocks.importRepo).toHaveBeenCalled());
}

describe("ImportRepoDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // The server drops recognized entries that fail create-path validation and
  // reports them as `invalid`; a summary that only counts created/skipped makes
  // a partially-dropped import read as a clean success (FEA-3263).
  it("reports entries the server dropped as invalid", async () => {
    await importFrom({ created: 3, skipped: 1, invalid: 2 });

    expect(
      await screen.findByText(RE_SUMMARY_WITH_INVALID)
    ).toBeInTheDocument();
  });

  it("omits the invalid count when nothing was dropped", async () => {
    await importFrom({ created: 2, skipped: 0, invalid: 0 });

    expect(await screen.findByText(RE_SUMMARY_CLEAN)).toBeInTheDocument();
    expect(screen.queryByText(RE_INVALID)).not.toBeInTheDocument();
  });
});
