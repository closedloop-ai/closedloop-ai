/**
 * ISS-9218 — what a host is allowed to SAY about an optional prop it does not
 * pass.
 *
 * The host↔surface parity ledgers (ISS-8636) had one escape hatch, `notSupported`
 * with a free-text reason, and it covered two situations a reader cannot tell
 * apart: a host that genuinely has nothing to wire, and a host that simply did
 * not pass a rendering option. The second is how `pageSizeOptions` came to be
 * supplied on web and withheld on desktop with nothing red — the reason string
 * was `"See onPageSizeChange."`, a pointer rather than a justification.
 *
 * The kind is declared ONCE, beside the surface's prop type, so a new optional
 * prop forces the decision where the prop is born rather than in whichever
 * ledger notices it first. `satisfies Record<OptionalPropKeys<Props>, …>` is what
 * makes that binding: a prop added to the type and not to the map fails `tsc`,
 * and a map entry the type no longer declares fails it too.
 */

/**
 * The prop wires something that BELONGS to the host — its data, its writes, its
 * persisted state, its routes, its read state, its layout, its query's limits.
 * A host that has none of that cannot honestly pass one, so `notSupported` with
 * a reason is a true statement and the guard accepts it.
 */
export const HOST_CAPABILITY = "host-capability" as const;

/**
 * The prop only CONFIGURES rendering the surface will otherwise default: an
 * option list, a seed, a preset. No host is unable to produce one, so
 * `notSupported` can never be true of it — a host that omits it is choosing the
 * surface default silently, and two hosts choosing differently is a divergence
 * the reader sees and nobody else does.
 *
 * A host either passes it, or declares it inert behind a companion the guard
 * checks (`inertWithout` / `inertUnder`) — a claim about another entry in the
 * same ledger, not a sentence only a human can grade.
 */
export const PRESENTATION = "presentation" as const;

export type SurfaceCapabilityKind =
  | typeof HOST_CAPABILITY
  | typeof PRESENTATION;

/**
 * The OPTIONAL keys of a prop type — the ones a host can silently drop. Required
 * props need no ledger entry and no kind, because `tsc` already fails on them.
 */
export type OptionalPropKeys<T> = {
  [K in keyof T]-?: object extends Pick<T, K> ? K : never;
}[keyof T];

/**
 * The declaration a surface makes: every optional prop it has, and which of the
 * two things it is.
 */
export type SurfaceCapabilityKinds<T> = Record<
  OptionalPropKeys<T>,
  SurfaceCapabilityKind
>;
