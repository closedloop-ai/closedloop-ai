import {
  DropdownMenu,
  DropdownMenuContent,
} from "@repo/design-system/components/ui/dropdown-menu";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../../shared/api/api-error";
import type { AgentSessionQueryFilters } from "../../../data-source/agent-sessions-data-source";
import { sessionsExportPath } from "../../../data-source/agent-sessions-data-source";
import { SessionsCsvExportMenuItem } from "../sessions-csv-export-menu-item";
import {
  SESSIONS_EXPORT_CSV_FAILED_LABEL,
  SESSIONS_EXPORT_CSV_LABEL,
  SESSIONS_EXPORT_CSV_PENDING_LABEL,
  SESSIONS_EXPORT_CSV_UNAVAILABLE_LABEL,
} from "../sessions-options-menu";

const getText = vi.fn();

vi.mock("../../../../shared/api/use-api-client", () => ({
  useApiClient: () => ({ getText }),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const FILTERS: AgentSessionQueryFilters = {
  harnesses: ["claude"],
  startDate: "2026-08-01T00:00:00.000Z",
};

function renderRow() {
  return render(
    <DropdownMenu open>
      <DropdownMenuContent>
        <SessionsCsvExportMenuItem filters={FILTERS} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The seam between {@link useSessionsCsvExport} and the presentational row.
 *
 * Both halves already have their own suites — the hook's fetch/classify
 * behaviour, and the row's label for each state — and NEITHER touches the
 * three-prop forward that joins them. `tsc` rejects a renamed or retyped prop,
 * so what is left to escape is a SAME-TYPE substitution: `failure={null}`,
 * `isExporting={false}`, an `onExport` that does not run the hook's export, or
 * `filters` that never reach it. Each case below fails under exactly one of
 * those, so the forward has to actually carry the value.
 */
describe("FEA-4217 — SessionsCsvExportMenuItem", () => {
  beforeEach(() => {
    getText.mockReset();
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:lane3");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
      () => undefined
    );
  });

  it("exports the row's own filters when the reader picks it", async () => {
    const user = userEvent.setup();
    getText.mockResolvedValue("Date,User\n");
    renderRow();

    await user.click(
      screen.getByRole("menuitem", { name: SESSIONS_EXPORT_CSV_LABEL })
    );

    // `onExport` runs the hook's export, and the `filters` prop is what scopes
    // it — an export of a different population than the view is showing is the
    // failure this pins.
    expect(getText).toHaveBeenCalledWith(sessionsExportPath(FILTERS));
  });

  it("says the export is running while the read is in flight", async () => {
    const user = userEvent.setup();
    let settle: (csv: string) => void = () => undefined;
    getText.mockReturnValue(
      new Promise<string>((resolve) => {
        settle = resolve;
      })
    );
    renderRow();

    await user.click(
      screen.getByRole("menuitem", { name: SESSIONS_EXPORT_CSV_LABEL })
    );

    // `isExporting` reached the row: a click that reports nothing back reads as
    // a dead control, and the row is the only place the reader is looking. The
    // menu item is a div, so the state a reader is given is `aria-disabled`.
    expect(
      await screen.findByRole("menuitem", {
        name: SESSIONS_EXPORT_CSV_PENDING_LABEL,
      })
    ).toHaveAttribute("aria-disabled", "true");

    settle("Date,User\n");
    // …and it clears, so the row is not stuck reporting a read that finished.
    expect(
      await screen.findByRole("menuitem", { name: SESSIONS_EXPORT_CSV_LABEL })
    ).toBeInTheDocument();
  });

  /**
   * ISS-10301: the retryable-failure label used to be pinned only through the
   * retired v1 `SessionsToolbar` Options menu, which mounted the row with a
   * literal `failure` prop. The contract is the row's, not that toolbar's, so it
   * is asserted here against the real classification instead of dying with it.
   */
  it("says in WORDS that a transient failure can be retried", async () => {
    const user = userEvent.setup();
    getText.mockRejectedValue(new ApiError("upstream unavailable", 503));
    renderRow();

    await user.click(
      screen.getByRole("menuitem", { name: SESSIONS_EXPORT_CSV_LABEL })
    );

    // The failure is TEXT, not a colour — a reader who cannot see hue still
    // learns nothing was downloaded (WCAG 1.4.1).
    expect(
      await screen.findByRole("menuitem", {
        name: SESSIONS_EXPORT_CSV_FAILED_LABEL,
      })
    ).toBeInTheDocument();
  });

  it("says in WORDS that a denied export cannot be retried", async () => {
    const user = userEvent.setup();
    getText.mockRejectedValue(new ApiError("forbidden", 403));
    renderRow();

    await user.click(
      screen.getByRole("menuitem", { name: SESSIONS_EXPORT_CSV_LABEL })
    );

    // `failure` reached the row, and reached it as the PERMANENT classification
    // rather than collapsing to "try again" on a denial that never can succeed.
    expect(
      await screen.findByRole("menuitem", {
        name: SESSIONS_EXPORT_CSV_UNAVAILABLE_LABEL,
      })
    ).toBeInTheDocument();
  });
});
