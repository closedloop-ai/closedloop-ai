import { isBelowPgTimestampFloor } from "@repo/api/src/types/pg-timestamp-floor";
import type { DesktopAgentComponentsPayload } from "@/lib/desktop-agent-sessions-schema";

type SyncedComponent = DesktopAgentComponentsPayload["components"][number];
type SyncedComponentVariant = NonNullable<SyncedComponent["variants"]>[number];

/**
 * ISS-8735 — the timestamp fields this pre-pass can degrade. `variants.*` are
 * reported under their own keys so one warn distinguishes a poisoned primary
 * from a poisoned revision.
 */
export const ComponentTimestampField = {
  FirstSeenAt: "firstSeenAt",
  LastSeenAt: "lastSeenAt",
  UninstalledAt: "uninstalledAt",
  ContentFirstSeenAt: "contentFirstSeenAt",
  ScannedAt: "scannedAt",
  VariantFirstSeenAt: "variants.firstSeenAt",
  VariantLastSeenAt: "variants.lastSeenAt",
} as const;

export type ComponentTimestampField =
  (typeof ComponentTimestampField)[keyof typeof ComponentTimestampField];

export type DegradedTimestampTally = Partial<
  Record<ComponentTimestampField, number>
>;

/**
 * The wire key each reported field reads from.
 *
 * BOTH HALVES OF THIS ARE LOAD-BEARING TYPES, and neither is decoration
 * (review: marisolashgrove). A list of plain `string` keys is a side inventory
 * over `syncedComponentSchema` that nothing holds to it — rename `firstSeenAt`
 * on the wire and this file still compiles while degrading nothing, so the
 * below-floor value goes straight back to throwing at the INSERT inside
 * `mapWithDbConcurrency`, and `withDb` is not a transaction, so the earlier
 * components stay durable while the request 500s and the desktop replays it
 * forever — the exact wedge this module exists to close. Typing the key as
 * `keyof SyncedComponent` makes that rename a compile error.
 *
 * `satisfies` rather than a type annotation, so the literal tuple types survive
 * for {@link ListedTimestampField} below.
 */
const COMPONENT_TIMESTAMP_FIELDS = [
  ["firstSeenAt", ComponentTimestampField.FirstSeenAt],
  ["lastSeenAt", ComponentTimestampField.LastSeenAt],
  ["uninstalledAt", ComponentTimestampField.UninstalledAt],
  ["contentFirstSeenAt", ComponentTimestampField.ContentFirstSeenAt],
  ["scannedAt", ComponentTimestampField.ScannedAt],
] as const satisfies readonly (readonly [
  keyof SyncedComponent,
  ComponentTimestampField,
])[];

const VARIANT_TIMESTAMP_FIELDS = [
  ["firstSeenAt", ComponentTimestampField.VariantFirstSeenAt],
  ["lastSeenAt", ComponentTimestampField.VariantLastSeenAt],
] as const satisfies readonly (readonly [
  keyof SyncedComponentVariant,
  ComponentTimestampField,
])[];

/** Every field the two lists above actually degrade. */
type ListedTimestampField =
  | (typeof COMPONENT_TIMESTAMP_FIELDS)[number][1]
  | (typeof VARIANT_TIMESTAMP_FIELDS)[number][1];

/**
 * The other half of the rename guard, in the repo's keys-covered shape
 * (`desktop-agent-sessions-schema-guards.ts`): adding a member to
 * {@link ComponentTimestampField} without adding it to one of the two lists
 * above fails `tsc` here rather than silently degrading nothing. A
 * `ReadonlySet<ComponentTimestampField>` or a typed list cannot catch that —
 * only a `Record` over the union, which cannot be written without naming every
 * member, can. Proven by `tsc`, so no test asserts it.
 */
export const componentTimestampFieldsCovered: Record<
  ComponentTimestampField,
  ListedTimestampField
> = {
  [ComponentTimestampField.FirstSeenAt]: ComponentTimestampField.FirstSeenAt,
  [ComponentTimestampField.LastSeenAt]: ComponentTimestampField.LastSeenAt,
  [ComponentTimestampField.UninstalledAt]:
    ComponentTimestampField.UninstalledAt,
  [ComponentTimestampField.ContentFirstSeenAt]:
    ComponentTimestampField.ContentFirstSeenAt,
  [ComponentTimestampField.ScannedAt]: ComponentTimestampField.ScannedAt,
  [ComponentTimestampField.VariantFirstSeenAt]:
    ComponentTimestampField.VariantFirstSeenAt,
  [ComponentTimestampField.VariantLastSeenAt]:
    ComponentTimestampField.VariantLastSeenAt,
};

/**
 * A value the Postgres `timestamp` domain cannot hold. Malformed strings are
 * deliberately NOT degraded: rejecting those is the wire schema's job, and this
 * pre-pass must not quietly widen its own remit. `isBelowPgTimestampFloor`
 * already answers false for the `NaN` a malformed string parses to.
 */
function isUnstorableTimestamp(value: unknown): boolean {
  return (
    typeof value === "string" && isBelowPgTimestampFloor(Date.parse(value))
  );
}

function omitKeys<T extends object>(value: T, keys: ReadonlySet<string>): T {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !keys.has(key))
  ) as T;
}

function collectOffendingKeys(
  record: Record<string, unknown>,
  fields: readonly (readonly [string, ComponentTimestampField])[],
  tally: DegradedTimestampTally
): ReadonlySet<string> {
  const offending = new Set<string>();
  for (const [key, field] of fields) {
    if (isUnstorableTimestamp(record[key])) {
      offending.add(key);
      tally[field] = (tally[field] ?? 0) + 1;
    }
  }
  return offending;
}

function degradeVariant(
  variant: SyncedComponentVariant,
  tally: DegradedTimestampTally
): SyncedComponentVariant {
  const offending = collectOffendingKeys(
    variant,
    VARIANT_TIMESTAMP_FIELDS,
    tally
  );
  return offending.size === 0 ? variant : omitKeys(variant, offending);
}

function degradeVariants(
  variants: readonly SyncedComponentVariant[] | undefined,
  tally: DegradedTimestampTally
): { variants: SyncedComponentVariant[] | undefined; changed: boolean } {
  if (!variants || variants.length === 0) {
    return { variants: undefined, changed: false };
  }
  const next = variants.map((variant) => degradeVariant(variant, tally));
  const changed = next.some((variant, index) => variant !== variants[index]);
  return { variants: next, changed };
}

function degradeComponent(
  component: SyncedComponent,
  tally: DegradedTimestampTally
): SyncedComponent {
  const offending = collectOffendingKeys(
    component,
    COMPONENT_TIMESTAMP_FIELDS,
    tally
  );
  const variants = degradeVariants(component.variants, tally);
  if (offending.size === 0 && !variants.changed) {
    return component;
  }
  const next =
    offending.size === 0 ? { ...component } : omitKeys(component, offending);
  if (variants.changed) {
    next.variants = variants.variants;
  }
  return next;
}

/**
 * ISS-8735 — DELETE (rather than null) every synced timestamp that sits below
 * the Postgres timestamp floor, so the INSERT that used to throw mid-batch
 * cannot. `withDb` here is not a transaction, so that throw left earlier
 * components durable while the request 500'd and the desktop re-sent forever.
 *
 * Deleting is what makes every sink correct with NO change to `parseDateField`
 * / `parseUpdateDateField`: the create arm's `parseDateField(undefined)` writes
 * `null`; the update arm's `lastSeenAt ?? undefined` and
 * `parseUpdateDateField(undefined)` are no-ops, so a poisoned `uninstalledAt`
 * can never clear an existing tombstone (FEA-4011); the version row's
 * `contentFirstSeenAt ?? lastSeenAt` and the registry's
 * `scannedAt ?? lastSeenAt` fall through their existing chains; and a variant
 * falls back to the component's own observation time. Nulling would break each
 * of those fallbacks by supplying a value.
 *
 * Pure, and returns the SAME reference for a component with nothing to degrade.
 * The tally exists so the caller emits ONE warn for the whole request rather
 * than one per row (`apps/api/AGENTS.md`, Emission and Abuse Control).
 */
export function degradeUnstorableComponentTimestamps(
  components: readonly SyncedComponent[]
): { components: SyncedComponent[]; degraded: DegradedTimestampTally } {
  const degraded: DegradedTimestampTally = {};
  return {
    components: components.map((component) =>
      degradeComponent(component, degraded)
    ),
    degraded,
  };
}
