import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RumValidationTrigger } from "../rum-validation-trigger";

const triggerButtonName = /trigger validation error/i;
const somethingWentWrongHeadingName = /something went wrong/i;
const { reportNextjsError } = vi.hoisted(() => ({
  reportNextjsError: vi.fn(),
}));

vi.mock("@/lib/datadog-rum/report-error", () => ({
  reportNextjsError,
}));

describe("RumValidationTrigger", () => {
  beforeEach(() => {
    reportNextjsError.mockClear();
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
        source: "rum-validation",
      }
    );
    expect(
      screen.getByRole("heading", { name: somethingWentWrongHeadingName })
    ).toBeInTheDocument();
  });
});
