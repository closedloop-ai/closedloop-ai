/**
 * ISS-4495: Regression coverage for the shared component `ResolutionBadge`
 * (FEA-3704), the ONE resolution badge rendered on both web (`apps/app`) and the
 * desktop renderer via `@repo/app`.
 *
 * The badge is purely presentational over the shared model
 * (`resolutionLabel` / `COMPONENT_RESOLUTION_LABELS`): it binds each state's
 * neutral `tone` to a concrete Chip variant (`TONE_VARIANT`) and a severity glyph
 * (`TONE_ICON`), and renders the human label plus the honest description. The
 * shared DERIVATION itself is covered in
 * `packages/api/src/types/component-resolution.test.ts`; this file guards the
 * component's binding so a tone→variant / label / description / gating regression
 * fails a test here.
 *
 * Coverage:
 *  - each display state renders its canonical label + tone-mapped Chip variant,
 *  - the honest DESCRIPTION reaches the tooltip content (label is not the only
 *    channel),
 *  - the disambiguation states the model exists to protect: `malformed` (unknown/
 *    absent raw state) and `unavailable` (inaccessible OR missing) render honestly
 *    and are NEVER collapsed into a lying "Resolved",
 *  - the fingerprint-refined states (`stale-definition`, `contract-mismatch`) only
 *    refine `resolved`, and absent fingerprint inputs leave a resolved component
 *    "Resolved" (older-client compat),
 *  - distinct visible output per state (no two states collapse into one label).
 *
 * These exercise the component's presentational BINDING in isolation across the
 * full display-state set. The production CALL PATH — how the sole caller
 * (`AgentDetail`) actually wires the badge (`resolvedState` +
 * `currentVersion.normalizerContractVersion`, and never a fingerprint pair) — is
 * covered in `agent-detail-resolution.test.tsx`, which is where the
 * genuinely-reachable states (including `contract-mismatch`) are proven through
 * the real render; the `stale-definition` fingerprint-diff derivation is owned by
 * the model test `packages/api/src/types/component-resolution.test.ts`.
 */

import { NORMALIZER_CONTRACT_VERSION } from "@repo/api/src/definition-fingerprint";
import { ComponentResolvedState } from "@repo/api/src/types/agent-component";
import {
  COMPONENT_RESOLUTION_LABELS,
  ComponentResolutionDisplayState,
} from "@repo/api/src/types/component-resolution";
import { tooltipMockModule } from "@repo/app/test/mocks/tooltip";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ResolutionBadge } from "../resolution-badge";

vi.mock("@repo/design-system/components/ui/tooltip", () => tooltipMockModule);

// Hoisted per biome useTopLevelRegex rule.
const SUCCESS_CLASS_RE = /text-success/;
const MUTED_CLASS_RE = /text-muted-foreground/;
const WARNING_CLASS_RE = /text-warning-foreground/;
const DANGER_CLASS_RE = /text-destructive/;

// The canonical labels/descriptions come from the SSOT map — never hardcoded here,
// so a deliberate copy change updates one place and the tests follow.
const RESOLVED =
  COMPONENT_RESOLUTION_LABELS[ComponentResolutionDisplayState.Resolved];
const UNRESOLVED =
  COMPONENT_RESOLUTION_LABELS[ComponentResolutionDisplayState.Unresolved];
const STALE =
  COMPONENT_RESOLUTION_LABELS[ComponentResolutionDisplayState.StaleDefinition];
const CONTRACT_MISMATCH =
  COMPONENT_RESOLUTION_LABELS[ComponentResolutionDisplayState.ContractMismatch];
const UNAVAILABLE =
  COMPONENT_RESOLUTION_LABELS[ComponentResolutionDisplayState.Unavailable];
const MALFORMED =
  COMPONENT_RESOLUTION_LABELS[ComponentResolutionDisplayState.Malformed];

// A pair of distinct 64-char-ish fingerprints, enough for a stale comparison.
const OBSERVED_HASH = "observed-definition-hash-aaaa";
const CURRENT_HASH = "current-definition-hash-bbbb";

// ── label + tone binding per display state ──────────────────────────────────────

describe("ResolutionBadge — each display state maps to its canonical label and tone", () => {
  it("resolved → 'Resolved' with the positive (success) Chip variant", () => {
    render(<ResolutionBadge resolvedState={ComponentResolvedState.Resolved} />);
    expect(screen.getByText(RESOLVED.label)).toBeInTheDocument();
    expect(document.body.innerHTML).toMatch(SUCCESS_CLASS_RE);
  });

  it("unresolved → 'Unresolved' with the neutral (muted) Chip variant", () => {
    render(
      <ResolutionBadge resolvedState={ComponentResolvedState.Unresolved} />
    );
    expect(screen.getByText(UNRESOLVED.label)).toBeInTheDocument();
    expect(document.body.innerHTML).toMatch(MUTED_CLASS_RE);
  });

  it("inaccessible → 'Unavailable' with the danger (destructive) Chip variant", () => {
    render(
      <ResolutionBadge resolvedState={ComponentResolvedState.Inaccessible} />
    );
    expect(screen.getByText(UNAVAILABLE.label)).toBeInTheDocument();
    expect(document.body.innerHTML).toMatch(DANGER_CLASS_RE);
  });

  it("missing → 'Unavailable' with the danger (destructive) Chip variant", () => {
    render(<ResolutionBadge resolvedState={ComponentResolvedState.Missing} />);
    expect(screen.getByText(UNAVAILABLE.label)).toBeInTheDocument();
    expect(document.body.innerHTML).toMatch(DANGER_CLASS_RE);
  });

  it("stale-definition → 'Stale definition' with the warning Chip variant", () => {
    render(
      <ResolutionBadge
        currentDefinitionHash={CURRENT_HASH}
        observedDefinitionHash={OBSERVED_HASH}
        resolvedState={ComponentResolvedState.Resolved}
      />
    );
    expect(screen.getByText(STALE.label)).toBeInTheDocument();
    expect(document.body.innerHTML).toMatch(WARNING_CLASS_RE);
  });

  it("contract-mismatch → 'Contract mismatch' with the warning Chip variant", () => {
    render(
      <ResolutionBadge
        normalizerContractVersion={NORMALIZER_CONTRACT_VERSION + 1}
        resolvedState={ComponentResolvedState.Resolved}
      />
    );
    expect(screen.getByText(CONTRACT_MISMATCH.label)).toBeInTheDocument();
    expect(document.body.innerHTML).toMatch(WARNING_CLASS_RE);
  });
});

// ── honest description reaches the tooltip (label is not the only channel) ───────

describe("ResolutionBadge — the honest description renders in the tooltip content", () => {
  it("surfaces the resolved description through the tooltip, not just the label", () => {
    render(<ResolutionBadge resolvedState={ComponentResolvedState.Resolved} />);
    const tooltip = screen.getByTestId("tooltip-content");
    expect(tooltip).toHaveTextContent(RESOLVED.description);
  });

  it("surfaces the unavailable description (last-known-good preserved) for a missing definition", () => {
    render(<ResolutionBadge resolvedState={ComponentResolvedState.Missing} />);
    const tooltip = screen.getByTestId("tooltip-content");
    expect(tooltip).toHaveTextContent(UNAVAILABLE.description);
  });

  it("keeps the tooltip trigger keyboard-focusable so the description is reachable without a pointer", () => {
    // The trigger is a Chip (<span>), which is NOT focusable by default — a
    // keyboard user could never reach the honest description. The badge wires
    // `interactive` + `tabIndex={0}`, so the trigger is in the tab order and can
    // receive focus (which is what pops the Radix tooltip in production).
    render(<ResolutionBadge resolvedState={ComponentResolvedState.Resolved} />);
    const trigger = document.querySelector('[data-slot="tooltip-trigger"]');
    expect(trigger).not.toBeNull();
    expect(trigger).toHaveAttribute("tabindex", "0");
    // Focusable in practice, not merely tab-indexed in the markup.
    (trigger as HTMLElement).focus();
    expect(trigger).toHaveFocus();
  });
});

// ── disambiguation the model exists to protect ──────────────────────────────────
// A regression that coerced an unknown/absent raw state — or a permission-denied /
// deleted definition — into a lying "Resolved" must fail here.

describe("ResolutionBadge — never lies about an unknown or unreadable state", () => {
  it("renders 'Malformed' (NOT 'Resolved') for an unknown raw state string", () => {
    render(<ResolutionBadge resolvedState="some_future_state" />);
    expect(screen.getByText(MALFORMED.label)).toBeInTheDocument();
    expect(screen.queryByText(RESOLVED.label)).not.toBeInTheDocument();
    expect(document.body.innerHTML).toMatch(DANGER_CLASS_RE);
  });

  it("renders 'Malformed' (NOT 'Resolved') for a null raw state", () => {
    render(<ResolutionBadge resolvedState={null} />);
    expect(screen.getByText(MALFORMED.label)).toBeInTheDocument();
    expect(screen.queryByText(RESOLVED.label)).not.toBeInTheDocument();
  });

  it("renders 'Malformed' (NOT 'Resolved') for an undefined raw state", () => {
    render(<ResolutionBadge resolvedState={undefined} />);
    expect(screen.getByText(MALFORMED.label)).toBeInTheDocument();
    expect(screen.queryByText(RESOLVED.label)).not.toBeInTheDocument();
  });

  it("keeps 'inaccessible' distinct from 'missing' at the model level while both display as 'Unavailable'", () => {
    // Both collapse to the same NON-LYING display state — but neither is ever
    // upgraded to 'Resolved'. Rendering both proves the danger tone, not a false
    // positive, backs a permission-denied AND a deleted definition.
    const { unmount } = render(
      <ResolutionBadge resolvedState={ComponentResolvedState.Inaccessible} />
    );
    expect(screen.getByText(UNAVAILABLE.label)).toBeInTheDocument();
    expect(screen.queryByText(RESOLVED.label)).not.toBeInTheDocument();
    unmount();

    render(<ResolutionBadge resolvedState={ComponentResolvedState.Missing} />);
    expect(screen.getByText(UNAVAILABLE.label)).toBeInTheDocument();
    expect(screen.queryByText(RESOLVED.label)).not.toBeInTheDocument();
  });
});

// ── fingerprint refinement only ever refines `resolved` (older-client compat) ───

describe("ResolutionBadge — fingerprint inputs only refine a resolved state", () => {
  it("leaves a resolved component 'Resolved' when NO fingerprint inputs are supplied (older client)", () => {
    render(<ResolutionBadge resolvedState={ComponentResolvedState.Resolved} />);
    expect(screen.getByText(RESOLVED.label)).toBeInTheDocument();
    expect(screen.queryByText(STALE.label)).not.toBeInTheDocument();
    expect(screen.queryByText(CONTRACT_MISMATCH.label)).not.toBeInTheDocument();
  });

  it("leaves a resolved component 'Resolved' when observed and current hashes MATCH", () => {
    render(
      <ResolutionBadge
        currentDefinitionHash={OBSERVED_HASH}
        observedDefinitionHash={OBSERVED_HASH}
        resolvedState={ComponentResolvedState.Resolved}
      />
    );
    expect(screen.getByText(RESOLVED.label)).toBeInTheDocument();
    expect(screen.queryByText(STALE.label)).not.toBeInTheDocument();
  });

  it("does NOT upgrade an UNRESOLVED component to stale-definition even with differing hashes", () => {
    // Fingerprint-derived states refine `resolved` ONLY; a non-resolved raw state
    // is never upgraded by fingerprint inputs (FEA-3704 precedence).
    render(
      <ResolutionBadge
        currentDefinitionHash={CURRENT_HASH}
        observedDefinitionHash={OBSERVED_HASH}
        resolvedState={ComponentResolvedState.Unresolved}
      />
    );
    expect(screen.getByText(UNRESOLVED.label)).toBeInTheDocument();
    expect(screen.queryByText(STALE.label)).not.toBeInTheDocument();
  });

  it("prefers contract-mismatch over stale-definition when both signals are present", () => {
    // Precedence: contract-mismatch (an unknown normalizer contract) outranks a
    // plain hash diff, because the fingerprint itself can't be trusted for the
    // exact-identity comparison stale relies on.
    render(
      <ResolutionBadge
        currentDefinitionHash={CURRENT_HASH}
        normalizerContractVersion={NORMALIZER_CONTRACT_VERSION + 1}
        observedDefinitionHash={OBSERVED_HASH}
        resolvedState={ComponentResolvedState.Resolved}
      />
    );
    expect(screen.getByText(CONTRACT_MISMATCH.label)).toBeInTheDocument();
    expect(screen.queryByText(STALE.label)).not.toBeInTheDocument();
  });
});

// ── distinct visible output per state ────────────────────────────────────────────

describe("ResolutionBadge — distinct visible label per state (no collapse)", () => {
  it("resolved and unavailable render distinct labels", () => {
    const { unmount } = render(
      <ResolutionBadge resolvedState={ComponentResolvedState.Resolved} />
    );
    expect(screen.getByText(RESOLVED.label)).toBeInTheDocument();
    unmount();

    render(<ResolutionBadge resolvedState={ComponentResolvedState.Missing} />);
    expect(screen.queryByText(RESOLVED.label)).not.toBeInTheDocument();
    expect(screen.getByText(UNAVAILABLE.label)).toBeInTheDocument();
  });

  it("stale-definition and contract-mismatch render distinct labels despite sharing the warning tone", () => {
    const { unmount } = render(
      <ResolutionBadge
        currentDefinitionHash={CURRENT_HASH}
        observedDefinitionHash={OBSERVED_HASH}
        resolvedState={ComponentResolvedState.Resolved}
      />
    );
    expect(screen.getByText(STALE.label)).toBeInTheDocument();
    unmount();

    render(
      <ResolutionBadge
        normalizerContractVersion={NORMALIZER_CONTRACT_VERSION + 1}
        resolvedState={ComponentResolvedState.Resolved}
      />
    );
    expect(screen.queryByText(STALE.label)).not.toBeInTheDocument();
    expect(screen.getByText(CONTRACT_MISMATCH.label)).toBeInTheDocument();
  });
});
