import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import {
  SessionDetailLoading,
  SessionDetailNotFound,
  SessionDetailProviderError,
} from "../../../agents/components/detail/agent-session-detail-states";
import {
  AgentDetailLoading,
  AgentDetailNotFound,
  AgentDetailUnavailable,
} from "../../../agents/components/workspace/agent-detail-states";
import {
  BranchDetailLoading,
  BranchDetailNotFound,
  BranchDetailProviderError,
} from "../../../branches/components/branch-detail-states";
import { BranchBackLabel } from "../../../branches/lib/branch-back-href";
import { AppCoreStoryProviders } from "../../storybook/decorators";

/**
 * ISS-5008, the states nobody screenshots.
 *
 * The session, branch and agent detail routes each set `suppressPageHeading` on
 * the shell Header because the LOADED body owns the page's `<h1>`. But that
 * heading sits below the loading and error early-returns, so on first load, on
 * a 404, and on a provider outage those routes shipped zero headings — the same
 * defect ISS-5008 exists to fix, on the three states the happy path never
 * reaches. These pin the heading outline to the state, not to the read
 * succeeding.
 */

const BACK_HREF = "/acme/sessions";

function renderState(ui: ReactElement) {
  return render(<AppCoreStoryProviders>{ui}</AppCoreStoryProviders>);
}

function headingNames(): string[] {
  return screen
    .getAllByRole("heading", { level: 1 })
    .map((node) => node.textContent ?? "");
}

describe("detail-route page headings in non-loaded states (ISS-5008)", () => {
  it.each([
    ["loading", <SessionDetailLoading key="s-l" />],
    ["not found", <SessionDetailNotFound backHref={BACK_HREF} key="s-n" />],
    [
      "provider error",
      <SessionDetailProviderError backHref={BACK_HREF} key="s-p" />,
    ],
  ])("names the session route in its %s state", (_state, ui) => {
    renderState(ui);
    expect(headingNames()).toEqual(["Session"]);
  });

  it.each([
    ["loading", <AgentDetailLoading key="a-l" />],
    ["not found", <AgentDetailNotFound backHref="/acme/agents" key="a-n" />],
    [
      "provider error",
      <AgentDetailUnavailable backHref="/acme/agents" key="a-p" />,
    ],
  ])("names the agent route in its %s state", (_state, ui) => {
    renderState(ui);
    expect(headingNames()).toEqual(["Agent"]);
  });

  it.each([
    ["loading", <BranchDetailLoading key="b-l" />],
    [
      "not found",
      <BranchDetailNotFound
        backHref="/acme/branches"
        backLabel={BranchBackLabel.Branches}
        key="b-n"
      />,
    ],
    [
      "provider error",
      <BranchDetailProviderError
        backHref="/acme/branches"
        backLabel={BranchBackLabel.Branches}
        key="b-p"
      />,
    ],
  ])("names the branch route in its %s state", (_state, ui) => {
    renderState(ui);
    expect(headingNames()).toEqual(["Branch"]);
  });
});
