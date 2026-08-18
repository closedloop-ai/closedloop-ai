import type {
  Organization,
  UpdateOrganizationInput,
} from "@repo/api/src/types/organization";
import type { Alert } from "@repo/design-system/components/ui/alert";
import type { Badge } from "@repo/design-system/components/ui/badge";
import type { ComponentProps } from "react";

type BadgeVariant = ComponentProps<typeof Badge>["variant"];

type AlertVariant = ComponentProps<typeof Alert>["variant"];

/**
 * The org-level privacy toggles that share the optional-field deploy-skew
 * contract (ISS-4624). Constrained to keys that exist on BOTH the read
 * contract and the update contract so a field can only be listed here if the
 * card can actually read it back and write it.
 */
export const OrgPolicyField = {
  SearchIncludeTranscripts: "searchIncludeTranscripts",
  SessionSyncPolicyEnabled: "sessionSyncPolicyEnabled",
} as const satisfies Record<
  string,
  keyof Organization & keyof UpdateOrganizationInput
>;

export type OrgPolicyField =
  (typeof OrgPolicyField)[keyof typeof OrgPolicyField];

/**
 * What the app actually knows about one org policy toggle, once the optional
 * wire field has been read. `Unavailable` is a first-class state, distinct from
 * both "still loading" (the query hasn't settled) and "off" (the server said
 * `false`): a previous-generation API strips the field entirely, and rendering
 * that as OFF would be a lie about a privacy gate.
 */
export const OrgPolicyFieldState = {
  Enabled: "enabled",
  Disabled: "disabled",
  Unavailable: "unavailable",
} as const;

export type OrgPolicyFieldState =
  (typeof OrgPolicyFieldState)[keyof typeof OrgPolicyFieldState];

/**
 * Outcome of the last save this card issued. `NotConfirmed` is the ISS-4624
 * failure the ticket exists for: the API answered 200 but neither the response
 * echo nor the follow-up read shows the requested value, so the write was an
 * effective no-op and must not be reported as success.
 */
export const OrgPolicySaveOutcome = {
  Idle: "idle",
  Saving: "saving",
  Applied: "applied",
  RequestFailed: "requestFailed",
  NotConfirmed: "notConfirmed",
} as const;

export type OrgPolicySaveOutcome =
  (typeof OrgPolicySaveOutcome)[keyof typeof OrgPolicySaveOutcome];

/**
 * Canonical badge presentation per resolved state. `null` means "no badge" —
 * the switch already says on/off, and a redundant chip next to it is noise.
 * Exhaustive so a new state has to make a deliberate call here.
 *
 * "Status unknown" in an `outline` badge: the chip's job is to label the state,
 * not to raise an alarm. `warning` (amber) is the loudest accent on an
 * otherwise calm stack of settings cards, and spending it on a non-action —
 * this card's own copy says nothing changed and there is nothing to do — both
 * over-shouts and collides with the genuine `warning` weight reserved for the
 * NotConfirmed save alert, the one thing the admin actually did that may not
 * have taken. An `outline` chip reads as a neutral label, not the product's
 * grey "turned off" muted chip and not an amber warning, so the sentence below
 * carries the weight while the chip just names the state.
 */
export const ORG_POLICY_FIELD_STATE_BADGES: Record<
  OrgPolicyFieldState,
  { label: string; variant: BadgeVariant } | null
> = {
  [OrgPolicyFieldState.Enabled]: null,
  [OrgPolicyFieldState.Disabled]: null,
  [OrgPolicyFieldState.Unavailable]: {
    label: "Status unknown",
    variant: "outline",
  },
};

export type OrgPolicySaveAlert = { message: string; variant: AlertVariant };

/**
 * Canonical inline alert per save outcome. `null` means the card shows nothing
 * — success is already visible in the switch once the org query refetches. The
 * two failure entries are deliberately different weights: a request that blew
 * up is an error, a request that returned 200 we cannot vouch for is a warning.
 */
export const ORG_POLICY_SAVE_OUTCOME_ALERTS: Record<
  OrgPolicySaveOutcome,
  OrgPolicySaveAlert | null
> = {
  [OrgPolicySaveOutcome.Idle]: null,
  [OrgPolicySaveOutcome.Saving]: null,
  [OrgPolicySaveOutcome.Applied]: null,
  [OrgPolicySaveOutcome.RequestFailed]: {
    message: "Couldn't save that change. Try again.",
    variant: "error",
  },
  [OrgPolicySaveOutcome.NotConfirmed]: {
    message:
      "Couldn't confirm that change saved. The switch shows what the server reports.",
    variant: "warning",
  },
};

/**
 * Shown in place of the switch when the server sent no value at all. It reports
 * exactly what the app can and cannot vouch for: the value is unreadable and
 * whatever the server is doing right now can't be confirmed from here. During
 * app/API deploy skew the enforcement code reads a column this API build does
 * not expose, so the app cannot honestly promise the current behavior either
 * way — claiming "still enforced, nothing changed" would be a guess dressed as
 * a fact. No "try again" prompt: when the cause is an API build that predates
 * the field, reloading cannot fix it, and telling someone to retry the
 * impossible is its own small lie.
 */
export const ORG_POLICY_UNAVAILABLE_EXPLANATION =
  "Can't read this setting from the server right now, so its current value and whether it's being enforced can't be confirmed from here.";

/**
 * Shown when the read that backs this card fails outright (a 500, a dropped
 * connection, an auth error). Like the unavailable state, the value can't be
 * confirmed — but here the cause is a live failure, not a stripped optional
 * field, and it is far more likely than the deploy-skew case. The raw server
 * error string is shown as secondary detail, never in the description slot
 * where the setting is supposed to explain itself.
 */
export const ORG_POLICY_ERROR_EXPLANATION =
  "Couldn't load this setting. Its current value can't be confirmed until the connection recovers — reload to try again.";

type OrgPolicyFieldsCarrier = Pick<Organization, OrgPolicyField>;

/**
 * Read one optional policy field off either side of the contract (the org read
 * or the update echo). Absent stays absent — it is never coerced to `false`.
 */
export function readOrgPolicyField(
  source: OrgPolicyFieldsCarrier | undefined,
  field: OrgPolicyField
): boolean | undefined {
  return source?.[field];
}

export function resolveOrgPolicyFieldState(
  value: boolean | undefined
): OrgPolicyFieldState {
  if (value === undefined) {
    return OrgPolicyFieldState.Unavailable;
  }
  if (value) {
    return OrgPolicyFieldState.Enabled;
  }
  return OrgPolicyFieldState.Disabled;
}

/**
 * Classify the last save. A 200 is not proof of application across the
 * supported app/API deploy skew: if the response omits the field (a previous
 * API stripped it) or echoes a different value, the write may have been a
 * no-op.
 *
 * Two things keep that verdict from going stale. `current` is the value the
 * live org query holds now, so a follow-up read that agrees with the request is
 * accepted as confirmation even when the write's own echo was useless.
 * `isRereading` covers the window between the write settling and that read
 * landing, so the warning never flashes while the answer is still in flight.
 */
export function resolveOrgPolicySaveOutcome({
  isPending,
  isError,
  isRereading,
  requested,
  echoed,
  current,
}: {
  isPending: boolean;
  isError: boolean;
  isRereading: boolean;
  requested: boolean | undefined;
  echoed: boolean | undefined;
  current: boolean | undefined;
}): OrgPolicySaveOutcome {
  if (isPending) {
    return OrgPolicySaveOutcome.Saving;
  }
  if (isError) {
    return OrgPolicySaveOutcome.RequestFailed;
  }
  if (requested === undefined) {
    return OrgPolicySaveOutcome.Idle;
  }
  if (echoed === requested || current === requested) {
    return OrgPolicySaveOutcome.Applied;
  }
  if (isRereading) {
    return OrgPolicySaveOutcome.Saving;
  }
  return OrgPolicySaveOutcome.NotConfirmed;
}

/**
 * Build the update payload for one policy field. A computed key would widen to
 * a string index signature, so each field is spelled out and the exhaustive
 * guard makes a newly added `OrgPolicyField` a compile error here.
 */
export function buildOrgPolicyUpdateInput(
  id: string,
  field: OrgPolicyField,
  value: boolean
): UpdateOrganizationInput {
  switch (field) {
    case OrgPolicyField.SearchIncludeTranscripts:
      return { id, searchIncludeTranscripts: value };
    case OrgPolicyField.SessionSyncPolicyEnabled:
      return { id, sessionSyncPolicyEnabled: value };
    default: {
      const exhaustive: never = field;
      return exhaustive;
    }
  }
}

/**
 * Everything the presentational card needs to know about the last save for one
 * field. Lives here rather than in the card so the `apps/app` container (which
 * derives it from the TanStack mutation observer) and the presentational card
 * in this package share one shape without the card importing a data hook.
 */
export type OrgPolicySaveState = {
  requested: boolean | undefined;
  isSaving: boolean;
  saveAlert: OrgPolicySaveAlert | null;
};
