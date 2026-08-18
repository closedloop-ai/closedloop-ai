/**
 * @file member-view.test.tsx
 * @description Behavioral tests for the FEA-4089 member by-source treatment:
 * the "Your packs" table is grouped Required / Installed, a required pack whose
 * push failed renders the honest "Required, install failed" strand row, each
 * installed row shows its provenance label, the Available list holds the rest,
 * and the loading / error / empty states render honestly.
 */

import {
  DistributionMode,
  DistributionTargetingType,
  DistributionTargetStatusValue,
} from "@repo/api/src/types/distribution";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../../shared/api/api-error";
import {
  API_NO_RESPONSE_STATUS,
  API_TIMEOUT_ERROR_CODE,
  API_TIMEOUT_ERROR_MESSAGE,
} from "../../../shared/api/api-timeout";
import type {
  PackDistribution,
  PackDistributionTarget,
  PackView,
} from "../../lib/pack-view";
import { MemberView } from "../member-view";

function target(
  overrides: Partial<PackDistributionTarget> = {}
): PackDistributionTarget {
  return {
    id: "tgt-1",
    status: DistributionTargetStatusValue.Installed,
    ...overrides,
  };
}

function distribution(
  overrides: Partial<PackDistribution> = {}
): PackDistribution {
  return {
    id: "dist-1",
    mode: DistributionMode.AutoInstall,
    targetingType: DistributionTargetingType.All,
    desiredEnabled: true,
    targetCount: 1,
    installedCount: 1,
    pendingCount: 0,
    failedCount: 0,
    targetingEntries: [],
    adoptionLoaded: true,
    ...overrides,
  };
}

function pack(overrides: Partial<PackView> = {}): PackView {
  return {
    id: "pack-1",
    name: "Security Baseline",
    publisher: "Platform Eng",
    version: "4.2.0",
    description: "Org security gates",
    verified: false,
    harnesses: [],
    installedHarnesses: [],
    installedByMe: false,
    contents: [],
    distribution: null,
    performance: null,
    ...overrides,
  };
}

const requiredPack = pack({
  id: "req",
  name: "Security Baseline",
  distribution: distribution({ mode: DistributionMode.AutoInstall }),
});

const blessedPack = pack({
  id: "blessed",
  name: "Release Notes Writer",
  distribution: distribution({
    mode: DistributionMode.OptIn,
    targets: [target({ status: DistributionTargetStatusValue.OptedIn })],
  }),
});

const availablePack = pack({
  id: "avail",
  name: "Changelog Bot",
  installedByMe: false,
  distribution: null,
});

describe("MemberView", () => {
  it("renders the Your packs region with a Required group and an Installed group", () => {
    render(<MemberView packs={[requiredPack, blessedPack]} />);

    expect(
      screen.getByRole("region", { name: "Your packs" })
    ).toBeInTheDocument();
    expect(screen.getByText("Required by your org")).toBeInTheDocument();
    expect(screen.getByText("Installed")).toBeInTheDocument();
    expect(screen.getByText("Security Baseline")).toBeInTheDocument();
    expect(screen.getByText("Release Notes Writer")).toBeInTheDocument();
  });

  it("labels an installed opt_in pack with its honest org-blessed provenance", () => {
    render(<MemberView packs={[blessedPack]} />);

    // FEA-4090 label for opted-in reads "Opted in" — the source is stated, not
    // color alone.
    expect(screen.getByText("Opted in")).toBeInTheDocument();
  });

  it("shows a required pack whose push failed as the honest strand row, not a silent absence", () => {
    render(
      <MemberView
        packs={[
          pack({
            id: "req-failed",
            name: "Migration Guardrails",
            distribution: distribution({
              mode: DistributionMode.AutoInstall,
              targets: [
                target({ status: DistributionTargetStatusValue.Failed }),
              ],
            }),
          }),
        ]}
      />
    );

    // The pack is present (in Required) AND its failure is stated in words.
    expect(screen.getByText("Migration Guardrails")).toBeInTheDocument();
    expect(screen.getByText("Required, install failed")).toBeInTheDocument();
  });

  it("puts a catalog pack the member doesn't have into the Available region", () => {
    render(<MemberView packs={[requiredPack, availablePack]} />);

    const available = screen.getByRole("region", { name: "Available" });
    expect(within(available).getByText("Changelog Bot")).toBeInTheDocument();
  });

  it("renders the skeleton while loading, not the empty state", () => {
    render(<MemberView isLoading packs={[]} />);

    expect(screen.getByTestId("member-packs-skeleton")).toBeInTheDocument();
    expect(screen.queryByText("No packs yet")).toBeNull();
  });

  it("renders an honest error state (never a misleading empty) when the read fails", () => {
    render(<MemberView error={new Error("boom")} packs={[]} />);

    expect(screen.getByText("Couldn't load packs")).toBeInTheDocument();
    expect(screen.queryByText("No packs yet")).toBeNull();
  });

  it("tells the same timeout story as the rest of the page on a client deadline", () => {
    // ISS-5002: the region used to carry its own "check your connection" copy,
    // so a timeout read one way here and another way on the page around it.
    render(
      <MemberView
        error={
          new ApiError(API_TIMEOUT_ERROR_MESSAGE, API_NO_RESPONSE_STATUS, {
            code: API_TIMEOUT_ERROR_CODE,
          })
        }
        packs={[]}
      />
    );

    expect(screen.getByText("Packs took too long to load")).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load packs")).toBeNull();
  });

  it("renders the empty state inside the primary region when the member has no packs", () => {
    render(<MemberView packs={[]} />);

    const region = screen.getByRole("region", { name: "Your packs" });
    expect(within(region).getByText("No packs yet")).toBeInTheDocument();
  });

  it("renders the supplied availableSlot as the Available region body (member-owned edit path)", () => {
    // The web surface passes its edit-capable catalog workspace here; the shared
    // view must render that slot verbatim so a member keeps the ability to select
    // and edit an OrgCustom pack they authored (FEA-4085 parity), rather than a
    // passive read-only list.
    render(
      <MemberView
        availableSlot={<div>edit-capable catalog</div>}
        packs={[availablePack]}
      />
    );

    const available = screen.getByRole("region", { name: "Available" });
    expect(
      within(available).getByText("edit-capable catalog")
    ).toBeInTheDocument();
    // The passive fallback list is NOT rendered when a slot is supplied.
    expect(within(available).queryByText("Changelog Bot")).toBeNull();
  });

  it("renders the availableSlot even when the fallback list would be empty (slot owns its own empty state)", () => {
    render(
      <MemberView
        availableSlot={<div>catalog workspace</div>}
        packs={[requiredPack]}
      />
    );

    expect(
      screen.getByRole("region", { name: "Available" })
    ).toBeInTheDocument();
    expect(screen.getByText("catalog workspace")).toBeInTheDocument();
  });

  it("keeps a supplied availableSlot mounted when the primary cloud read fails (slot owns its own state)", () => {
    // Regression (FEA-4166): on desktop the availableSlot is the fully-local
    // PluginsPanel install surface, which needs no cloud. A failed cloud catalog
    // read (signed out / offline / 500 on /catalog) surfaces its error in the
    // primary "Your packs" region only — it must NOT unmount the Available slot
    // and collapse the page to a single error card.
    render(
      <MemberView
        availableSlot={<div>local install surface</div>}
        error={new Error("catalog read failed")}
        packs={[]}
      />
    );

    // The primary region owns the cloud error…
    expect(screen.getByText("Couldn't load packs")).toBeInTheDocument();
    // …and the local slot stays mounted alongside it.
    expect(
      screen.getByRole("region", { name: "Available" })
    ).toBeInTheDocument();
    expect(screen.getByText("local install surface")).toBeInTheDocument();
  });

  it("scopes a specific auto_install distribution to the targeted member — untargeted members don't see it as Required", () => {
    const specificPack = pack({
      id: "targeted-elsewhere",
      name: "Locale Pack",
      distribution: distribution({
        mode: DistributionMode.AutoInstall,
        targetingType: DistributionTargetingType.Specific,
        targetingEntries: [{ computeTargetId: null, userId: "someone-else" }],
      }),
    });

    render(<MemberView memberUserId="member-me" packs={[specificPack]} />);

    // Not required for this member: no Required heading, and the pack surfaces
    // in Available instead.
    expect(screen.queryByText("Required by your org")).toBeNull();
    const available = screen.getByRole("region", { name: "Available" });
    expect(within(available).getByText("Locale Pack")).toBeInTheDocument();
  });
});
