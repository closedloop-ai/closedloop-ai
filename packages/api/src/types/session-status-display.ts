/**
 * @file session-status-display.ts
 * @description The user-facing COPY for the session-status vocabularies — the
 * labels and the two explanatory sentences. Split out of `./session-status.ts`
 * by ISS-5592 so a bundle-sensitive `"use client"` surface that renders a badge
 * can import three strings without pulling in the folds, the normalizers, and
 * the staleness derivation.
 *
 * The only import is the sibling values module, which is dependency-free — no
 * parser, no validator, no zod. That is the property that matters here: this
 * module must stay reachable from a client bundle without dragging one in.
 *
 * The VALUES, the folds, and `STALE_SESSION_DISPLAY_THRESHOLD_HOURS` live next
 * door in `./session-status.ts`. Which vocabulary a value belongs to, and why
 * there are two, is documented in that file's header.
 */
import {
  type DisplayedSessionStatus,
  SESSION_STATUS,
} from "./session-status.ts";

/**
 * Canonical user-facing labels for {@link SESSION_STATUS}. The values live next
 * to the wire contract so non-React runtimes, including desktop E2E tests, can
 * assert rendered labels without re-encoding the vocabulary.
 *
 * ISS-10364 (operator ruling, 2026-09-23/24) retired the `waiting`/`unknown`/
 * `stale` labels and their explanatory tooltips this module used to export —
 * all three display-only words are gone from {@link DisplayedSessionStatus}
 * itself, folded to `active` before any render sees them.
 */
export const SESSION_STATUS_LABELS: Record<DisplayedSessionStatus, string> = {
  [SESSION_STATUS.ACTIVE]: "Active",
  [SESSION_STATUS.INACTIVE]: "Inactive",
  [SESSION_STATUS.ERROR]: "Failed",
};
