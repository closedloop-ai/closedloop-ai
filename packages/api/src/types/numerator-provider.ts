/**
 * The numerator-provider seam (ISS-8399).
 *
 * Every "value delivered" metric divides SOMETHING by a cost. Historically that
 * something was LOC, hardcoded at each call site, so every label, tooltip and
 * axis title spelled the unit itself. This module makes the unit a property of
 * a PROVIDER instead, so a second source of delivery value (Pensero delivery
 * points today, JIRA story points tomorrow) is a new member here rather than a
 * hand-edit of every surface that names a unit.
 *
 * Three rules the seam exists to enforce:
 *
 * 1. **LOC is a provider, not the baseline.** It is the DEFAULT member of the
 *    same closed set, so nothing has to special-case "the non-LOC case".
 * 2. **The map is exhaustive.** {@link NUMERATOR_PROVIDER_DESCRIPTORS} is typed
 *    `Record<NumeratorProvider, …>`, so adding a member without describing it
 *    fails `tsc` rather than rendering an undefined unit.
 * 3. **The basis travels with the number.** {@link NumeratorBasis} is the wire
 *    discriminator every metric response carries, so a client can word itself
 *    from the response instead of hardcoding a unit. This is the discriminator
 *    ISS-6526 is held on for its absence; with an OPEN provider set it stops
 *    being a nicety and becomes the only way a reader knows what it is reading.
 *
 * This module is deliberately pure and dependency-free: `apps/app`, the desktop
 * renderer, and `apps/api` all read it, and none of them may pull a database or
 * a provider client in through it.
 */

/**
 * The closed set of sources a delivery numerator may come from.
 *
 * Adding a member here is the whole cost of adding a provider: `tsc` then names
 * every map and switch that must classify it. Members are lowercase wire values
 * because they are persisted and serialized (see {@link NumeratorBasis}).
 */
export const NumeratorProvider = {
  /** Lines of code, derived from our own git/PR data. The default. */
  Loc: "loc",
  /** Pensero delivery points, extracted from the Pensero delivery feed. */
  Pensero: "pensero",
} as const;
export type NumeratorProvider =
  (typeof NumeratorProvider)[keyof typeof NumeratorProvider];

/**
 * Everything a surface needs in order to render a provider's numbers without
 * knowing which provider it has.
 *
 * `unitLabel` is the short form a chart axis or a compact card uses; `unitName`
 * is the long form for a tooltip or a sentence. Both are here (rather than one
 * derived from the other) because "LOC" does not expand to "LOCs".
 */
export type NumeratorProviderDescriptor = {
  readonly id: NumeratorProvider;
  /** Compact unit for axes, chips and dense cells (e.g. "LOC", "pts"). */
  readonly unitLabel: string;
  /**
   * ISS-11117: the unit as a DENSE SUMMARY CARD names it — "LOC", "Pts".
   *
   * A second spelling of the same unit, which needs justifying because a second
   * spelling is normally the drift this seam exists to stop. `unitLabel` is the
   * one a branch-detail card and a chart axis print, where the provider's name
   * earns its width and the reader may never have seen the metric before. A
   * listing's summary strip is five cards on one row at phone width, and
   * "Pensero pts / $" does not survive that column — the surfaces the ticket
   * names ask for `Pts / $`.
   *
   * It is a FIELD of the descriptor rather than a truncation rule so the short
   * form stays a declared property of the provider: LOC's short form is its
   * long form, and a future provider's is whatever its owner says, not whatever
   * a substring of its name happens to be.
   */
  readonly shortUnitLabel: string;
  /** Long unit for prose and tooltips (e.g. "lines of code"). */
  readonly unitName: string;
  /** Digits to render after the decimal point for this provider's values. */
  readonly fractionDigits: number;
  /**
   * True when the provider's values arrive from an EXTERNAL feed that must be
   * associated to our records before they can be read, so coverage is a
   * property of the association store rather than of our own data. A surface
   * uses this to decide whether "no value" can mean "not yet backfilled".
   */
  readonly requiresAssociation: boolean;
};

/**
 * The default provider when nothing has selected one. LOC, because it is
 * derived from data we already hold and therefore always available.
 */
export const DEFAULT_NUMERATOR_PROVIDER: NumeratorProvider =
  NumeratorProvider.Loc;

/**
 * EXHAUSTIVE provider descriptions. Typed `Record<NumeratorProvider, …>` so a
 * new member fails typecheck here first — which is the point of the seam.
 */
export const NUMERATOR_PROVIDER_DESCRIPTORS: Record<
  NumeratorProvider,
  NumeratorProviderDescriptor
> = {
  [NumeratorProvider.Loc]: {
    id: NumeratorProvider.Loc,
    unitLabel: "LOC",
    // Identical to `unitLabel` on purpose: "LOC" is already as short as the unit
    // gets, and `perDollarShortLabelFor(Loc)` therefore reproduces
    // `LOC_PER_DOLLAR_LABEL` exactly — pinned by test, so the LOC arm of any
    // surface that adopts the short label is byte-identical to what it renders
    // today.
    shortUnitLabel: "LOC",
    unitName: "lines of code",
    fractionDigits: 0,
    requiresAssociation: false,
  },
  [NumeratorProvider.Pensero]: {
    id: NumeratorProvider.Pensero,
    unitLabel: "Pensero pts",
    shortUnitLabel: "Pts",
    unitName: "Pensero delivery points",
    // Pensero emits tenth-of-a-point values (0.1, 2.2, 0.9) verbatim.
    fractionDigits: 1,
    requiresAssociation: true,
  },
};

/**
 * The wire discriminator carried alongside every numerator value.
 *
 * `unitLabel` is denormalized onto the wire on purpose: a client that has not
 * shipped an update yet still knows a member of the open provider set by the
 * unit it renders, instead of falling back to a hardcoded "LOC" that is now a
 * lie. `providerId` is what code branches on; `unitLabel` is what copy reads.
 */
export type NumeratorBasis = {
  readonly providerId: NumeratorProvider;
  readonly unitLabel: string;
};

/**
 * Narrow an untrusted value (a query parameter, a stored column, an older
 * client's payload) to a known provider. Returns `null` rather than defaulting
 * to LOC: a caller that silently substitutes the default for an unrecognized
 * provider would render one provider's numbers under another's unit.
 */
export function parseNumeratorProvider(
  value: unknown
): NumeratorProvider | null {
  if (typeof value !== "string") {
    return null;
  }
  const members: readonly string[] = Object.values(NumeratorProvider);
  return members.includes(value) ? (value as NumeratorProvider) : null;
}

/** The descriptor for a provider. Total over the closed set. */
export function numeratorProviderDescriptor(
  providerId: NumeratorProvider
): NumeratorProviderDescriptor {
  return NUMERATOR_PROVIDER_DESCRIPTORS[providerId];
}

/** The wire basis for a provider — what a metric response carries. */
export function numeratorBasisFor(
  providerId: NumeratorProvider
): NumeratorBasis {
  return {
    providerId,
    unitLabel: NUMERATOR_PROVIDER_DESCRIPTORS[providerId].unitLabel,
  };
}

/**
 * ISS-9814: the spaced per-dollar label for a provider — "LOC / $",
 * "Pensero pts / $".
 *
 * DERIVED from {@link NumeratorProviderDescriptor.unitLabel} rather than
 * declared per provider, so the unit cannot be spelled one way on a card and
 * another in a label. The LOC arm reproduces `LOC_PER_DOLLAR_LABEL`
 * (`../utils/loc-per-dollar.ts`) exactly; that agreement is pinned by a test
 * rather than by an import, because this module is deliberately dependency-free
 * and the two owners answer different questions — that one owns the LOC metric,
 * this one owns what a unit is called for an arbitrary provider.
 */
export function perDollarLabelFor(providerId: NumeratorProvider): string {
  return `${NUMERATOR_PROVIDER_DESCRIPTORS[providerId].unitLabel} / $`;
}

/**
 * ISS-11117: the per-dollar label a DENSE SUMMARY CARD prints — "LOC / $",
 * "Pts / $".
 *
 * The same spacing as {@link perDollarLabelFor} over
 * {@link NumeratorProviderDescriptor.shortUnitLabel} instead of `unitLabel`, so
 * the two labels cannot name one provider's unit two ways by accident: both are
 * derived from the descriptor, and a new provider declares both forms or fails
 * `tsc`.
 *
 * The LOC arm equals `LOC_PER_DOLLAR_LABEL` (`../utils/loc-per-dollar.ts`) by
 * construction; that agreement is pinned by a test rather than an import,
 * because this module is deliberately dependency-free.
 */
export function perDollarShortLabelFor(providerId: NumeratorProvider): string {
  return `${NUMERATOR_PROVIDER_DESCRIPTORS[providerId].shortUnitLabel} / $`;
}

/**
 * ISS-9814: the COMPACT per-dollar unit a dense metric card prints beside its
 * number — "LOC/$", "Pensero pts/$". The unspaced sibling of
 * {@link perDollarLabelFor}, and derived from the same `unitLabel` so a card's
 * label and its unit chip cannot name two different providers.
 */
export function perDollarUnitLabelFor(providerId: NumeratorProvider): string {
  return `${NUMERATOR_PROVIDER_DESCRIPTORS[providerId].unitLabel}/$`;
}
