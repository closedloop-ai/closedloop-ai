/**
 * @file convert-install-sheet.test.tsx
 * @description Behavioral tests for the convert→install preview/confirm Sheet
 * (FEA-4080). Render the Sheet from capability fixtures resolved off the real
 * FEA-4078 map and assert the honest state each renders (clean / partial /
 * unsupported / offline / converting / done / error), that a partial convert
 * requires an explicit confirm before install, that unsupported/offline block
 * with a reason, that provenance is shown, and that the confirm/cancel controls
 * carry accessible names. No timing, no source scans — drive the production path
 * and assert observable behavior.
 */

import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import type {
  ConvertFailureClass,
  ConvertInstallOutcome,
  ConvertInstallState,
} from "@repo/api/src/types/convert-install";
import {
  ConvertInstallState as ConvertState,
  ConvertFailureClass as FailureClass,
} from "@repo/api/src/types/convert-install";
import {
  ConversionSupport,
  resolveConversionCapability,
} from "@repo/api/src/types/harness-conversion";
import { HarnessName } from "@repo/crewd/model";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  ConvertInstallSheet,
  type ConvertInstallTarget,
} from "../convert-install-sheet";

const PROVENANCE_COPY = /Originally a Codex skill/;
const RECONVERTED_PROVENANCE_COPY =
  /Originally a Claude agent, currently in Codex format/;
const FAILURE_ALERT_COPY = /didn't finish on Claude/;
const FAILURE_ALERT_COPY_CODEX = /didn't finish on Codex/;
const TRANSIENT_MESSAGE_COPY = /The gateway timed out\./;
const PERMANENT_MESSAGE_COPY = /No install command for this pack\./;
const DONE_FROM_CURRENT_COPY = /converted from Codex and is ready to use/;
const ARROW_CURRENT_HARNESS = /Codex/;
const ARROW_TARGET_HARNESS = /OpenCode/;
const ARROW_ORIGIN_HARNESS = /Claude/;

const HARNESS_LABEL: Record<HarnessName, string> = {
  [HarnessName.Claude]: "Claude",
  [HarnessName.Codex]: "Codex",
  [HarnessName.Opencode]: "OpenCode",
};
const harnessLabel = (harness: HarnessName): string => HARNESS_LABEL[harness];

// A clean-convertible target: a skill converts losslessly across harnesses.
const cleanTarget: ConvertInstallTarget = {
  packId: "pack-clean",
  name: "Docs helper",
  kind: AgentComponentKind.Skill,
  currentHarness: HarnessName.Codex,
  targetHarness: HarnessName.Claude,
  sourceHarness: HarnessName.Codex,
};

// A partial (lossy) target: a claude subagent → codex drops model/allowedTools.
const partialTarget: ConvertInstallTarget = {
  packId: "pack-partial",
  name: "Reviewer agent",
  kind: AgentComponentKind.Subagent,
  currentHarness: HarnessName.Claude,
  targetHarness: HarnessName.Codex,
  sourceHarness: HarnessName.Claude,
};

// An unsupported target: a hook has no cross-harness equivalent.
const unsupportedTarget: ConvertInstallTarget = {
  packId: "pack-unsupported",
  name: "Pre-commit hook",
  kind: AgentComponentKind.Hook,
  currentHarness: HarnessName.Claude,
  targetHarness: HarnessName.Codex,
  sourceHarness: HarnessName.Claude,
};

const outcomeFor = (
  state: ConvertInstallState,
  droppedFields: readonly string[] = [],
  extras?: { failureClass?: ConvertFailureClass; message?: string }
): ConvertInstallOutcome => ({
  state,
  identity: {
    id: "id",
    name: "name",
    kind: AgentComponentKind.Skill,
    sourceHarness: HarnessName.Codex,
    currentHarness: HarnessName.Codex,
    targetHarness: HarnessName.Claude,
  },
  capability: { support: ConversionSupport.Supported, droppedFields: [] },
  droppedFields,
  failureClass: extras?.failureClass,
  message: extras?.message,
});

// A target whose CURRENT format differs from its origin provenance: authored for
// Claude, already converted to Codex, now converting Codex → OpenCode. The
// conversion label must name the CURRENT format (Codex), not the Claude
// provenance — the exact case wongk flagged.
const reconvertedTarget: ConvertInstallTarget = {
  packId: "pack-reconverted",
  name: "Reviewer agent",
  kind: AgentComponentKind.Subagent,
  currentHarness: HarnessName.Codex,
  targetHarness: HarnessName.Opencode,
  sourceHarness: HarnessName.Claude,
};

const renderSheet = (
  target: ConvertInstallTarget,
  overrides?: {
    onConvertInstall?: (
      target: ConvertInstallTarget
    ) => Promise<ConvertInstallOutcome>;
    targetOffline?: boolean;
    onOpenChange?: (open: boolean) => void;
  }
) => {
  const onConvertInstall =
    overrides?.onConvertInstall ??
    vi.fn(() => Promise.resolve(outcomeFor(ConvertState.Installed)));
  const onOpenChange = overrides?.onOpenChange ?? vi.fn();
  render(
    <ConvertInstallSheet
      harnessLabel={harnessLabel}
      onConvertInstall={onConvertInstall}
      onOpenChange={onOpenChange}
      target={target}
      targetOffline={overrides?.targetOffline}
    />
  );
  return { onConvertInstall, onOpenChange };
};

describe("ConvertInstallSheet", () => {
  it("shows provenance and the source→target direction", () => {
    renderSheet(cleanTarget);
    // Provenance: the harness the component was originally authored for.
    expect(screen.getByText(PROVENANCE_COPY)).toBeInTheDocument();
    // The source→target direction is announced by the arrow's accessible name.
    expect(screen.getByLabelText("converts to")).toBeInTheDocument();
    // The install title names the target harness.
    expect(screen.getByText("Install on Claude")).toBeInTheDocument();
  });

  it("names both origin and current format when the component was already converted", () => {
    // A subagent authored for Claude, previously converted to Codex, now being
    // converted Codex→OpenCode: provenance keeps the Claude origin AND names the
    // current Codex format (FEA-4028), so it isn't mistaken for a Codex-native.
    renderSheet({
      packId: "pack-reconverted",
      name: "Reviewer agent",
      kind: AgentComponentKind.Subagent,
      currentHarness: HarnessName.Codex,
      targetHarness: HarnessName.Opencode,
      sourceHarness: HarnessName.Claude,
    });
    expect(screen.getByText(RECONVERTED_PROVENANCE_COPY)).toBeInTheDocument();
  });

  it("shows the shared FEA-4083 install-state token in the header", () => {
    // The header renders the canonical InstallStateStatus in the shared packs
    // vocabulary, so the convert flow reads its state the same way every other
    // packs surface does. A clean/partial preview reads "Not installed".
    renderSheet(cleanTarget);
    expect(screen.getByText("Not installed")).toBeInTheDocument();
  });

  it("tracks the unsupported state in the shared header token", () => {
    renderSheet(unsupportedTarget);
    expect(screen.getByText("Not supported")).toBeInTheDocument();
  });

  it("renders the clean state as a lossless preview", () => {
    renderSheet(cleanTarget);
    expect(screen.getByText("Converts cleanly")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Convert and install" })
    ).toBeEnabled();
  });

  it("renders the partial state with a loss warning and the dropped fields", () => {
    const capability = resolveConversionCapability(
      partialTarget.kind,
      partialTarget.currentHarness,
      partialTarget.targetHarness
    );
    expect(capability.support).toBe(ConversionSupport.Partial);
    renderSheet(partialTarget);
    expect(screen.getByText("Lossy conversion")).toBeInTheDocument();
    // Each dropped field is named so the loss is explicit before confirm.
    for (const field of capability.droppedFields) {
      expect(screen.getByText(field)).toBeInTheDocument();
    }
  });

  it("requires an explicit loss confirm for a partial convert before installing", async () => {
    const user = userEvent.setup();
    const { onConvertInstall } = renderSheet(partialTarget);
    // The confirm button says "…anyway" — the explicit acknowledgement of loss.
    const confirm = screen.getByRole("button", {
      name: "Convert and install anyway",
    });
    // Nothing installs until the user confirms.
    expect(onConvertInstall).not.toHaveBeenCalled();
    await user.click(confirm);
    await waitFor(() => expect(onConvertInstall).toHaveBeenCalledTimes(1));
    expect(onConvertInstall).toHaveBeenCalledWith(partialTarget);
  });

  it("blocks an unsupported convert with a reason and never installs", async () => {
    const user = userEvent.setup();
    const { onConvertInstall } = renderSheet(unsupportedTarget);
    expect(screen.getByText("Can't convert to Codex")).toBeInTheDocument();
    const confirm = screen.getByRole("button", { name: "Can't install" });
    expect(confirm).toBeDisabled();
    // Clicking the disabled block button cannot start an install.
    await user.click(confirm);
    expect(onConvertInstall).not.toHaveBeenCalled();
  });

  it("blocks an offline target with a reason even when the convert would succeed", async () => {
    const user = userEvent.setup();
    const { onConvertInstall } = renderSheet(cleanTarget, {
      targetOffline: true,
    });
    expect(screen.getByText("Claude is offline")).toBeInTheDocument();
    const confirm = screen.getByRole("button", { name: "Can't install" });
    expect(confirm).toBeDisabled();
    await user.click(confirm);
    expect(onConvertInstall).not.toHaveBeenCalled();
  });

  it("shows the converting state while the engine call is in flight", async () => {
    const user = userEvent.setup();
    let resolveInstall: (o: ConvertInstallOutcome) => void = () => undefined;
    const onConvertInstall = vi.fn(
      () =>
        new Promise<ConvertInstallOutcome>((resolve) => {
          resolveInstall = resolve;
        })
    );
    renderSheet(cleanTarget, { onConvertInstall });
    await user.click(
      screen.getByRole("button", { name: "Convert and install" })
    );
    // In-flight: the aria-live status region and the "Installing" label.
    await screen.findByRole("status");
    expect(
      screen.getByText("Converting and installing on Claude")
    ).toBeInTheDocument();
    // Cancel is sealed while converting.
    expect(
      screen.getByRole("button", { name: "Cancel convert and install" })
    ).toBeDisabled();
    resolveInstall(outcomeFor(ConvertState.Installed));
    await screen.findByText("Installed on Claude");
  });

  it("renders the done state and reports dropped fields on a partial install", async () => {
    const user = userEvent.setup();
    const onConvertInstall = vi.fn(() =>
      Promise.resolve(
        outcomeFor(ConvertState.Partial, ["model", "allowedTools"])
      )
    );
    renderSheet(partialTarget, { onConvertInstall });
    await user.click(
      screen.getByRole("button", { name: "Convert and install anyway" })
    );
    await screen.findByText("Installed on Codex with changes");
    expect(screen.getByText("model")).toBeInTheDocument();
    expect(screen.getByText("allowedTools")).toBeInTheDocument();
    // Done offers a single accessible Done control.
    expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
  });

  it("renders the error state as retryable when the engine reports an error", async () => {
    const user = userEvent.setup();
    const onConvertInstall = vi.fn(() =>
      Promise.resolve(outcomeFor(ConvertState.Error))
    );
    renderSheet(cleanTarget, { onConvertInstall });
    await user.click(
      screen.getByRole("button", { name: "Convert and install" })
    );
    // The failure Alert's unique description (the header token also reads
    // "Install failed" — the shared FEA-4083 label — so assert the body copy).
    await screen.findByText(FAILURE_ALERT_COPY);
    // The confirm becomes a retry.
    expect(
      screen.getByRole("button", { name: "Try again" })
    ).toBeInTheDocument();
  });

  it("degrades a rejected engine call to the retryable error state without crashing", async () => {
    const user = userEvent.setup();
    const onConvertInstall = vi.fn(() => Promise.reject(new Error("boom")));
    renderSheet(cleanTarget, { onConvertInstall });
    await user.click(
      screen.getByRole("button", { name: "Convert and install" })
    );
    await screen.findByText(FAILURE_ALERT_COPY);
    expect(
      screen.getByRole("button", { name: "Try again" })
    ).toBeInTheDocument();
  });

  it("keeps a launched (still-streaming) convert in the converting state, not done", async () => {
    // A clean convert's engine outcome is `Converting` — the run was LAUNCHED and
    // streams to completion via the existing IPC path. The Sheet must NOT claim
    // the install finished: it stays on the in-flight body with the dismiss
    // surface sealed, never painting the Done body or its "Done" control.
    const user = userEvent.setup();
    const onConvertInstall = vi.fn(() =>
      Promise.resolve(outcomeFor(ConvertState.Converting))
    );
    renderSheet(cleanTarget, { onConvertInstall });
    await user.click(
      screen.getByRole("button", { name: "Convert and install" })
    );
    await waitFor(() => expect(onConvertInstall).toHaveBeenCalledTimes(1));
    expect(
      await screen.findByText("Converting and installing on Claude")
    ).toBeInTheDocument();
    // No premature success: neither the Done body nor its control appears.
    expect(screen.queryByText("Installed on Claude")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Done" })
    ).not.toBeInTheDocument();
    // The dismiss surface stays sealed while the run streams.
    expect(
      screen.getByRole("button", { name: "Cancel convert and install" })
    ).toBeDisabled();
  });

  it("keeps the dropped-field list visible on the retry screen after a failed partial install", async () => {
    // A lossy convert that fails must not strip the loss information on the retry
    // screen — the user is re-confirming the SAME lossy install, so the dropped
    // fields stay listed under the failure Alert.
    const user = userEvent.setup();
    const capability = resolveConversionCapability(
      partialTarget.kind,
      partialTarget.currentHarness,
      partialTarget.targetHarness
    );
    const onConvertInstall = vi.fn(() =>
      Promise.resolve(outcomeFor(ConvertState.Error))
    );
    renderSheet(partialTarget, { onConvertInstall });
    await user.click(
      screen.getByRole("button", { name: "Convert and install anyway" })
    );
    // partialTarget converts to Codex, so the failure body names Codex.
    await screen.findByText(FAILURE_ALERT_COPY_CODEX);
    // The loss breakdown survives the error swap.
    for (const field of capability.droppedFields) {
      expect(screen.getByText(field)).toBeInTheDocument();
    }
    expect(
      screen.getByRole("button", { name: "Try again" })
    ).toBeInTheDocument();
  });

  it("exposes accessible names on the confirm and cancel controls", () => {
    renderSheet(cleanTarget);
    expect(
      screen.getByRole("button", { name: "Cancel convert and install" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Convert and install" })
    ).toBeInTheDocument();
  });

  it("labels the conversion by the current format, not the origin provenance", () => {
    // wongk: a Claude-authored component already in Codex format converts
    // Codex → OpenCode. The direction arrow must read "Codex → OpenCode" (the
    // real from-format the engine converts), while provenance stays "Claude".
    renderSheet(reconvertedTarget);
    const arrow = screen.getByLabelText("converts to").closest("span");
    expect(arrow).toHaveTextContent(ARROW_CURRENT_HARNESS);
    expect(arrow).toHaveTextContent(ARROW_TARGET_HARNESS);
    // The arrow names the current format, NOT the Claude provenance.
    expect(arrow).not.toHaveTextContent(ARROW_ORIGIN_HARNESS);
    // Provenance is still shown in the body (origin + current format).
    expect(screen.getByText(RECONVERTED_PROVENANCE_COPY)).toBeInTheDocument();
  });

  it("reports the current format in the done copy, not the origin provenance", async () => {
    const user = userEvent.setup();
    const onConvertInstall = vi.fn(() =>
      Promise.resolve(outcomeFor(ConvertState.Installed))
    );
    renderSheet(reconvertedTarget, { onConvertInstall });
    await user.click(
      screen.getByRole("button", { name: "Convert and install" })
    );
    // Installed on the target (OpenCode) and converted FROM the current Codex
    // format — never claiming it converted from the Claude provenance.
    await screen.findByText("Installed on OpenCode");
    expect(screen.getByText(DONE_FROM_CURRENT_COPY)).toBeInTheDocument();
  });

  it("keeps retry available and shows the message for a transient failure", async () => {
    const user = userEvent.setup();
    const onConvertInstall = vi.fn(() =>
      Promise.resolve(
        outcomeFor(ConvertState.Error, [], {
          failureClass: FailureClass.Transient,
          message: "The gateway timed out.",
        })
      )
    );
    renderSheet(cleanTarget, { onConvertInstall });
    await user.click(
      screen.getByRole("button", { name: "Convert and install" })
    );
    // The engine's actionable message is surfaced (the description also carries
    // the "Try again." invitation, so match the message substring).
    await screen.findByText(TRANSIENT_MESSAGE_COPY);
    // Transient → retry stays available and enabled.
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
  });

  it("blocks retry and shows the message for a permanent failure", async () => {
    const user = userEvent.setup();
    const onConvertInstall = vi.fn(() =>
      Promise.resolve(
        outcomeFor(ConvertState.Error, [], {
          failureClass: FailureClass.Permanent,
          message: "No install command for this pack.",
        })
      )
    );
    renderSheet(cleanTarget, { onConvertInstall });
    await user.click(
      screen.getByRole("button", { name: "Convert and install" })
    );
    // The engine's message is surfaced, and the confirm reads as blocked.
    await screen.findByText(PERMANENT_MESSAGE_COPY);
    const confirm = screen.getByRole("button", { name: "Can't install" });
    expect(confirm).toBeDisabled();
    // A permanent failure never offers an enabled "Try again".
    expect(
      screen.queryByRole("button", { name: "Try again" })
    ).not.toBeInTheDocument();
    // Clicking the blocked confirm cannot re-run the install.
    await user.click(confirm);
    expect(onConvertInstall).toHaveBeenCalledTimes(1);
  });

  it("degrades an unclassified engine error to a retryable failure", async () => {
    // An older desktop producer returns an error with no failureClass. It must
    // stay retryable so it degrades safely (cross-repo compatibility).
    const user = userEvent.setup();
    const onConvertInstall = vi.fn(() =>
      Promise.resolve(outcomeFor(ConvertState.Error))
    );
    renderSheet(cleanTarget, { onConvertInstall });
    await user.click(
      screen.getByRole("button", { name: "Convert and install" })
    );
    await screen.findByText(FAILURE_ALERT_COPY);
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
  });

  it("resets to a fresh preview when the same pack switches harness target", async () => {
    // wongk: the stale-phase bug. Install pack-x → Claude to Done, then rerender
    // the SAME packId targeting OpenCode. Keying by the full conversion identity
    // remounts a fresh Preview instead of carrying the stale Done state.
    const user = userEvent.setup();
    const onConvertInstall = vi.fn(() =>
      Promise.resolve(outcomeFor(ConvertState.Installed))
    );
    const switchingTarget: ConvertInstallTarget = {
      packId: "pack-switch",
      name: "Docs helper",
      kind: AgentComponentKind.Skill,
      currentHarness: HarnessName.Codex,
      targetHarness: HarnessName.Claude,
      sourceHarness: HarnessName.Codex,
    };
    const { rerender } = render(
      <ConvertInstallSheet
        harnessLabel={harnessLabel}
        onConvertInstall={onConvertInstall}
        onOpenChange={vi.fn()}
        target={switchingTarget}
      />
    );
    await user.click(
      screen.getByRole("button", { name: "Convert and install" })
    );
    await screen.findByText("Installed on Claude");
    // Switch the SAME pack to a new target while the Sheet stays open.
    rerender(
      <ConvertInstallSheet
        harnessLabel={harnessLabel}
        onConvertInstall={onConvertInstall}
        onOpenChange={vi.fn()}
        target={{ ...switchingTarget, targetHarness: HarnessName.Opencode }}
      />
    );
    // The stale Done state does NOT survive the target switch: a fresh preview
    // for the new target renders instead.
    expect(screen.queryByText("Installed on Claude")).not.toBeInTheDocument();
    expect(screen.getByText("Install on OpenCode")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Convert and install" })
    ).toBeInTheDocument();
  });
});
