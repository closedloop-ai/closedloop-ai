import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RumErrorSource } from "@/lib/datadog-rum/error-source";
import { RumValidationTrigger } from "../rum-validation-trigger";

const triggerButtonName = /trigger validation error/i;
const somethingWentWrongHeadingName = /something went wrong/i;
const { reportNextjsError } = vi.hoisted(() => ({
  reportNextjsError: vi.fn(),
}));
const { getInternalContext } = vi.hoisted(() => ({
  getInternalContext: vi.fn(),
}));

vi.mock("@/lib/datadog-rum/report-error", () => ({
  reportNextjsError,
}));

vi.mock("@datadog/browser-rum", () => ({
  datadogRum: { getInternalContext },
}));

describe("RumValidationTrigger", () => {
  beforeEach(() => {
    reportNextjsError.mockClear();
    getInternalContext.mockReset();
  });

  it("does not throw until the explicit user action", async () => {
    render(<RumValidationTrigger />);

    await expect(
      screen.findByRole("button", { name: triggerButtonName })
    ).resolves.toBeInTheDocument();
  });

  it("reports the fixed validation error after click", async () => {
    render(<RumValidationTrigger />);

    await userEvent.click(
      screen.getByRole("button", { name: triggerButtonName })
    );

    expect(reportNextjsError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "rum-validation-stage-client-render",
      }),
      {
        routeTemplate: "/rum-validation",
        source: RumErrorSource.RumValidation,
      }
    );
    expect(
      screen.getByRole("heading", { name: somethingWentWrongHeadingName })
    ).toBeInTheDocument();
  });

  it("marks the heading tracked when the SDK's internal context has a session", async () => {
    getInternalContext.mockReturnValue({ session_id: "abc123" });
    render(<RumValidationTrigger />);

    await userEvent.click(
      screen.getByRole("button", { name: triggerButtonName })
    );

    expect(
      screen.getByRole("heading", { name: somethingWentWrongHeadingName })
    ).toHaveAttribute("data-rum-session-tracked", "true");
  });

  it("marks the heading not-tracked when the SDK sampled the session out", async () => {
    getInternalContext.mockReturnValue(undefined);
    render(<RumValidationTrigger />);

    await userEvent.click(
      screen.getByRole("button", { name: triggerButtonName })
    );

    expect(
      screen.getByRole("heading", { name: somethingWentWrongHeadingName })
    ).toHaveAttribute("data-rum-session-tracked", "false");
  });
});
