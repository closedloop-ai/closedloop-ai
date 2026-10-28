import { BRANCHES_LISTING_LOADING_PARITY_FLAG_KEY } from "@repo/api/src/types/branches-listing-loading-parity-flag";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GitHubConnectAction } from "../../../github/lib/github-connect-action";
import { BranchesListStateKind } from "../../lib/branch-list-state";
import { BranchesListStateView } from "../branches-list-state-view";
import type { BranchesStallCta } from "../branches-stall-cta";

/**
 * ISS-10645 — the operator's ruling that a stalled Branches load offers a CTA
 * resolved from the READER's state, not from the shell asking.
 *
 * Every case drives the real component through the real flag adapter at the hard
 * stall phase, so deleting the slot, the resolver, or the flag read reddens it.
 */

const CREATE_ACCOUNT_LABEL = "Create account";
const CONNECT_GITHUB_LABEL = "Connect GitHub";
/** Stands in for the host's own handoff report. @see BranchesStallCta.connectOutcome */
const CONNECT_OUTCOME_TEXT = "GitHub connect could not be opened.";

function renderStall(stallCta: BranchesStallCta | undefined) {
  return render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({
        enabledFlags: [BRANCHES_LISTING_LOADING_PARITY_FLAG_KEY],
      })}
    >
      <BranchesListStateView
        onRetry={() => undefined}
        onShowAllTime={() => undefined}
        stallCta={stallCta}
        stallPhase="hard"
        state={{ kind: BranchesListStateKind.Loading }}
      />
    </FeatureFlagAdapterProvider>
  );
}

const GUEST: BranchesStallCta = {
  createAccountAction: <button type="button">{CREATE_ACCOUNT_LABEL}</button>,
  githubConnect: {
    action: GitHubConnectAction.Connect,
    onConnect: () => undefined,
  },
  signals: { hasAccount: false, isGitHubConnected: false },
};

const SIGNED_IN_NO_GITHUB: BranchesStallCta = {
  createAccountAction: <button type="button">{CREATE_ACCOUNT_LABEL}</button>,
  githubConnect: {
    action: GitHubConnectAction.Connect,
    onConnect: () => undefined,
  },
  signals: { hasAccount: true, isGitHubConnected: false },
};

const SIGNED_IN_NO_GITHUB_WITH_OUTCOME: BranchesStallCta = {
  ...SIGNED_IN_NO_GITHUB,
  connectOutcome: <p>{CONNECT_OUTCOME_TEXT}</p>,
};

const SIGNED_IN_CONNECTED: BranchesStallCta = {
  createAccountAction: <button type="button">{CREATE_ACCOUNT_LABEL}</button>,
  githubConnect: {
    action: GitHubConnectAction.Connect,
    onConnect: () => undefined,
  },
  signals: { hasAccount: true, isGitHubConnected: true },
};

describe("Branches stalled-load CTA", () => {
  it("offers a guest the account CTA and not the connect one", () => {
    renderStall(GUEST);
    expect(screen.getByText(CREATE_ACCOUNT_LABEL)).toBeInTheDocument();
    expect(screen.queryByText(CONNECT_GITHUB_LABEL)).toBeNull();
  });

  it("offers a signed-in reader without GitHub the connect CTA, never the account one", () => {
    renderStall(SIGNED_IN_NO_GITHUB);
    expect(screen.getByText(CONNECT_GITHUB_LABEL)).toBeInTheDocument();
    expect(screen.queryByText(CREATE_ACCOUNT_LABEL)).toBeNull();
  });

  // ISS-11274: a host
  // that can observe its handoff failing must be able to say so under the very
  // control that started it — otherwise a refused sign-in is indistinguishable
  // from a click that did nothing.
  it("reports the host's connect outcome under the connect CTA", () => {
    renderStall(SIGNED_IN_NO_GITHUB_WITH_OUTCOME);
    expect(screen.getByText(CONNECT_GITHUB_LABEL)).toBeInTheDocument();
    expect(screen.getByText(CONNECT_OUTCOME_TEXT)).toBeInTheDocument();
  });

  // …and only under THAT arm: a reader being asked for an account, or asked for
  // nothing, never made a connect handoff for this to be reporting on.
  it("withholds the connect outcome on the account arm", () => {
    renderStall({ ...GUEST, connectOutcome: <p>{CONNECT_OUTCOME_TEXT}</p> });
    expect(screen.getByText(CREATE_ACCOUNT_LABEL)).toBeInTheDocument();
    expect(screen.queryByText(CONNECT_OUTCOME_TEXT)).toBeNull();
  });

  it("offers a connected reader neither CTA, leaving the shared Retry", () => {
    renderStall(SIGNED_IN_CONNECTED);
    expect(screen.queryByText(CREATE_ACCOUNT_LABEL)).toBeNull();
    expect(screen.queryByText(CONNECT_GITHUB_LABEL)).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("asks for nothing when the host reports no signals at all", () => {
    renderStall(undefined);
    expect(screen.queryByText(CREATE_ACCOUNT_LABEL)).toBeNull();
    expect(screen.queryByText(CONNECT_GITHUB_LABEL)).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});

describe("Branches loading parity gate", () => {
  it("keeps the shipped centred text with the flag closed", () => {
    render(
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({ enabledFlags: [] })}
      >
        <BranchesListStateView
          onRetry={() => undefined}
          onShowAllTime={() => undefined}
          stallCta={GUEST}
          stallPhase="hard"
          state={{ kind: BranchesListStateKind.Loading }}
        />
      </FeatureFlagAdapterProvider>
    );
    expect(screen.getByText("Loading branches…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.queryByText(CREATE_ACCOUNT_LABEL)).toBeNull();
  });
});
