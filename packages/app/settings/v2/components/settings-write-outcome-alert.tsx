"use client";

import {
  Alert,
  AlertDescription,
} from "@repo/design-system/components/ui/alert";
import { SettingsPanelDataState } from "../lib/settings-panel-data-state";

/**
 * Why a Settings v2 write did not take, for the outcomes the shared toast gets
 * WRONG (ISS-8367).
 *
 * A refusal and an undecided read get their own sentence, because the generic
 * mutation toast tells the user to try again and that is wrong advice for both:
 * a member retrying an admin-gated write gets the same 403 forever, and a user
 * told they lack access the server never checked goes and asks an admin for a
 * permission they may already hold.
 *
 * `Failed` renders NOTHING, deliberately. `makeQueryClient`'s default
 * `mutations.onError` toasts a generic failure for every rejected mutation
 * whose hook does not set `suppressDefaultErrorToast`. The panels that mount
 * this alert DO set it, so this component is the only voice on a failed write
 * there — which is why it now answers for `Failed` as well.
 *
 * IT DID NOT ALWAYS. `Failed` was `null` here on the theory that the shared
 * toast owned it, and review of #6638 found the flaw: the toast is not
 * per-outcome, so it fired on 403 and 503 too and every refusal arrived as two
 * conflicting messages — the #6392 double-message defect, moved onto the two
 * states this alert was added to speak for. One suppression plus one exhaustive
 * map is the fix: exactly one sentence per outcome, chosen by the outcome.
 *
 * Every sentence states that nothing changed. A write that failed must never
 * read as one that partly succeeded.
 *
 * THE REFUSAL SENTENCE IS THE PANEL'S, not this module's, because what a 403
 * MEANS differs by domain: a refused custom-field write really does need an
 * admin, while the tags routes carry no admin gate at all, so telling a user to
 * ask an admin there sends them after a permission nobody holds — the same harm
 * as the generic retry advice, one level subtler. The default is deliberately
 * neutral so a panel that says nothing cannot invent a policy by omission.
 */
export function SettingsWriteOutcomeAlert({
  state,
  forbiddenMessage = SETTINGS_WRITE_FORBIDDEN_MESSAGE,
}: Readonly<{
  state: SettingsPanelDataState | null;
  forbiddenMessage?: string;
}>) {
  if (state === null) {
    return null;
  }
  const message =
    state === SettingsPanelDataState.Forbidden
      ? forbiddenMessage
      : SETTINGS_WRITE_OUTCOME_MESSAGE[state];
  if (message === null) {
    return null;
  }
  return (
    <Alert variant="error">
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}

/** The neutral refusal: true of every domain, claiming a policy for none. */
const SETTINGS_WRITE_FORBIDDEN_MESSAGE =
  "You aren't allowed to make that change. Nothing was changed.";

/**
 * THE sentence for a write the service could not decide, shared with
 * `other-labs-settings-panel.tsx` so the two screens cannot answer the same
 * outcome differently after a wording change lands on one of them.
 */
export const SETTINGS_WRITE_UNAVAILABLE_MESSAGE =
  "We couldn't reach the service, so nothing was changed and nothing about your access was decided. Try again shortly.";

/**
 * Keyed EXHAUSTIVELY by the union so a new data state fails `tsc` here rather
 * than silently inheriting another outcome's sentence. Only the READ-only
 * states map to `null` — they are not write outcomes and this alert never
 * speaks for them. `Forbidden` holds the neutral default; a panel whose domain
 * really does have an admin gate overrides it.
 */
const SETTINGS_WRITE_OUTCOME_MESSAGE: Record<
  SettingsPanelDataState,
  string | null
> = {
  [SettingsPanelDataState.Forbidden]: SETTINGS_WRITE_FORBIDDEN_MESSAGE,
  [SettingsPanelDataState.Unavailable]: SETTINGS_WRITE_UNAVAILABLE_MESSAGE,
  [SettingsPanelDataState.Failed]:
    "That change didn't go through. Nothing was changed — try again.",
  [SettingsPanelDataState.Loading]: null,
  [SettingsPanelDataState.Ready]: null,
  [SettingsPanelDataState.Empty]: null,
};
