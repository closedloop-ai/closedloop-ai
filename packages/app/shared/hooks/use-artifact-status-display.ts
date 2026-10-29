"use client";

import {
  type ArtifactStatusDisplay,
  UNKNOWN_ARTIFACT_STATUS_DISPLAY,
} from "@repo/api/src/types/artifact-status-display";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { ARTIFACT_STATUS_LABEL_HONESTY_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";

/**
 * THE ONE READ SITE for `artifact-status-label-honesty` (ISS-9560), handing out
 * the RESOLVED copy rather than the boolean.
 *
 * `null` means the gate is shut: the caller keeps whatever private answer it
 * gave before, unchanged. Non-null is both the swap signal AND the words to
 * render, so a call site cannot take the new branch and then invent its own
 * wording for it.
 *
 * WHY A HOOK MODULE AND NOT A READ PER COMPONENT. `no-threaded-feature-flag`
 * (`pnpm check:source-gates`) forbids BOTH available shortcuts wherever two
 * components in ONE module need the decision — reading the key in each is
 * `duplicate-read`, and reading it once in the parent and passing the boolean
 * down is `thread`. `status-badge.tsx` (Document + Issue badges) and
 * `my-tasks-kanban.tsx` (lane card + drag preview) are both that shape. A
 * second module reading the key is the remedy the rule names, not a second
 * violation: every consumer still reads for itself, and the boolean never
 * crosses a call boundary.
 *
 * WHY `shared/hooks` AND NOT THE `projects` SLICE. `shared/components/
 * status-badge.tsx` is one of its consumers, and `packages/app/AGENTS.md` ->
 * Dependency Direction says `shared/*` must never import a feature slice —
 * which the slice home made it do, and made circular besides, since this module
 * reads back into `shared/feature-flags` and `shared/lib/feature-flags`. The
 * copy it hands out is not projects-specific either: the documents slice, the
 * My Tasks board and a server unfurl all render it.
 *
 * `…Optional` because the shared surfaces that call this — the status icons,
 * the badges — also mount in Storybook and in mini-table tests that wire no
 * provider. There they resolve to the closed default, which is the honest
 * pre-flag render rather than a crashed subtree.
 */
export function useArtifactStatusDisplay(): ArtifactStatusDisplay | null {
  return useFeatureFlagEnabledOptional(
    ARTIFACT_STATUS_LABEL_HONESTY_FEATURE_FLAG_KEY
  )
    ? UNKNOWN_ARTIFACT_STATUS_DISPLAY
    : null;
}
