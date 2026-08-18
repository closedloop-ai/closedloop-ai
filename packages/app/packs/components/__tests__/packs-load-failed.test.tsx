import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../shared/api/api-error";
import {
  API_TIMEOUT_ERROR_CODE,
  API_TIMEOUT_ERROR_MESSAGE,
} from "../../../shared/api/api-timeout";
import { PacksLoadFailed } from "../packs-load-failed";

/** The raw transport string that must never reach a customer. */
const RAW_SERVER_MESSAGE = /relation does not exist/;

// ISS-5002/ISS-5013: the shared Packs failure state. Its whole job is to keep
// "we stopped waiting" and "the server answered with a failure" from collapsing
// into one message, and to never put a raw transport string in front of a user.

function timeoutError() {
  return new ApiError(API_TIMEOUT_ERROR_MESSAGE, 0, {
    code: API_TIMEOUT_ERROR_CODE,
  });
}

describe("PacksLoadFailed", () => {
  it("states a client-deadline timeout distinctly from a server failure", () => {
    render(<PacksLoadFailed error={timeoutError()} onRetry={vi.fn()} />);

    expect(screen.getByText("Packs took too long to load")).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load packs")).not.toBeInTheDocument();
  });

  it("renders the generic failed-read state for a server error", () => {
    render(
      <PacksLoadFailed
        error={new ApiError("relation does not exist", 500)}
        onRetry={vi.fn()}
      />
    );

    expect(screen.getByText("Couldn't load packs")).toBeInTheDocument();
    expect(
      screen.queryByText("Packs took too long to load")
    ).not.toBeInTheDocument();
    // A raw transport/DB message must never reach a customer.
    expect(screen.queryByText(RAW_SERVER_MESSAGE)).not.toBeInTheDocument();
  });

  it("falls back to the generic state when the surface only knows it failed", () => {
    render(<PacksLoadFailed onRetry={vi.fn()} />);

    expect(screen.getByText("Couldn't load packs")).toBeInTheDocument();
  });

  it("announces itself, since it replaces a role=status loading region", () => {
    render(<PacksLoadFailed error={timeoutError()} onRetry={vi.fn()} />);

    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("omits the retry affordance when the surface cannot retry", () => {
    render(<PacksLoadFailed error={timeoutError()} />);

    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });
});
