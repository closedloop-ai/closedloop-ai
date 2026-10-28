import {
  NumeratorProvider,
  perDollarShortLabelFor,
} from "@repo/api/src/types/numerator-provider";
import {
  formatLocPerDollar,
  formatPenseroPointsPerDollar,
} from "@repo/app/shared/lib/format-utils";

/**
 * ISS-11117 — the Sessions LISTING's per-dollar card, number and words chosen
 * ONCE.
 *
 * The Sessions summary already resolves FOUR basis-dependent strings — label,
 * caption, `what`, `how` — through one fold, precisely so they cannot land on
 * different arms. This adds the numerator to that set instead of beside it: a
 * caller cannot take {@link SessionsListPerDollar.value} without the label that
 * names what it counts, because they arrive in one object.
 *
 * ## The selection is keyed on the PRODUCER, never on the reader
 *
 * `penseroPointsPerDollar` is published only for a principal who passes the
 * SERVER half of `pensero-points-per-dollar`, so the reader question is already
 * answered by the time a payload reaches here. That is the whole gate, one key,
 * and it removes a class of desktop/web divergence: a client-side flag delivery
 * that fails cannot shut a gate nothing reads here.
 *
 * ## The LOC arm is the shipped card
 *
 * Its label, caption and both sentences stay with the basis fold that owns them
 * (`merged-loc-per-dollar-basis.ts`) — the caller resolves them and hands them
 * in, so the ISS-9978/ISS-10667 vocabulary rules keep their single owner and
 * this module does not become a second place that spells the LOC ratio.
 */
export type SessionsListPerDollar = {
  /** Which numerator the figure counts. The card branches on nothing else. */
  readonly providerId: NumeratorProvider;
  /** The ratio, or `null` when there is none to render. */
  readonly value: number | null;
  /** The card's heading. */
  readonly label: string;
  /** The population phrase under the value. */
  readonly detail: string;
  /** How the number renders. Travels with the label. */
  readonly format: (value: number | null | undefined) => string;
  /** The info popover; its `how` must describe the numerator in play. */
  readonly info: { readonly what: string; readonly how: string };
};

/** The LOC arm's four basis-dependent strings, resolved by the caller. */
export type SessionsLocPerDollarCopy = {
  readonly label: string;
  readonly detail: string;
  readonly what: string;
  readonly how: string;
};

/**
 * Choose the Sessions-listing per-dollar metric and the words describing it.
 *
 * The Pensero arm is selected only when the producer sent a NUMBER. `undefined`
 * is the absent field — no numerator for this reader, this population, or this
 * delivery read — and is the AC2 state: the LOC card renders unchanged. A
 * present `0` is a measured zero and IS selected, which is why this tests for a
 * finite number rather than truthiness.
 */
export function resolveSessionsListPerDollar(
  usage:
    | {
        readonly penseroPointsPerDollar?: number;
      }
    | undefined,
  options: {
    readonly locValue: number | null;
    readonly locCopy: SessionsLocPerDollarCopy;
  }
): SessionsListPerDollar {
  const points = usage?.penseroPointsPerDollar;
  if (typeof points === "number" && Number.isFinite(points)) {
    return {
      providerId: NumeratorProvider.Pensero,
      value: points,
      label: perDollarShortLabelFor(NumeratorProvider.Pensero),
      detail: "across sessions in range",
      format: formatPenseroPointsPerDollar,
      info: {
        what: "Pensero delivery points per dollar, output efficiency. Higher is better.",
        how: "Every role's share of each Pensero-scored interaction on the branches these sessions touched, counted once per interaction, divided by the total estimated cost across matched sessions. Pensero delivery history is swept backwards and is never provably complete, so this total is a lower bound.",
      },
    };
  }
  return {
    providerId: NumeratorProvider.Loc,
    value: options.locValue,
    label: options.locCopy.label,
    detail: options.locCopy.detail,
    format: formatLocPerDollar,
    info: { what: options.locCopy.what, how: options.locCopy.how },
  };
}
