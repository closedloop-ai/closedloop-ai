import { redactAnalyticsUrl } from "./redact-analytics-url";

/**
 * The posthog-js persistence records that hold a "person info" pair (ISS-8660).
 *
 * Both are read while posthog-js builds the property bag for EVERY event —
 * `$client_session_props.props` via `SessionPropsManager.getSessionProps`,
 * `$initial_person_info` via `PostHogPersistence.get_initial_props` once the
 * person is identified — and both land in `getPersonPropsFromInfo`, which calls
 * `String.prototype.split` on `u` and `.search` on `r` with no type check
 * (posthog-js 1.359.1, the copy `@posthog/next@0.1.0` pins and initializes). A
 * stored non-string throws inside `calculateEventProperties`, so no event is
 * ever built and capture stops entirely.
 *
 * Persistence is `localStorage+cookie`, so one bad write outlives the tab and no
 * deploy clears it — hence a sweep at load, not validation on the way out.
 */
export const PersistedPersonInfoKey = {
  ClientSessionProps: "$client_session_props",
  InitialPersonInfo: "$initial_person_info",
} as const;
export type PersistedPersonInfoKey =
  (typeof PersistedPersonInfoKey)[keyof typeof PersistedPersonInfoKey];

/**
 * Emitted once per load on which a record had to be repaired. Zero events and
 * zero activity are indistinguishable from the dashboard side; this is the
 * signal that tells them apart.
 */
export const ANALYTICS_PERSISTENCE_REPAIRED_EVENT =
  "analytics_persistence_repaired";

/** A field dropped from a stored record, and why. */
export type DroppedPersonInfoField = {
  field: RepairablePersonInfoField;
  /**
   * `typeof` the rejected value, never the value: these records hold a referrer
   * and a full `window.location.href`, and this report crosses to a third-party
   * analytics processor.
   */
  valueType: string;
};

/** A record that needed rewriting, and the record to write in its place. */
export type PersistedPersonInfoRepair = {
  key: PersistedPersonInfoKey;
  value: Record<string, unknown>;
  dropped: DroppedPersonInfoField[];
  /**
   * Fields kept as strings but with a sensitive query-param value masked out.
   * Names only — the whole point is that the value does not travel.
   */
  redacted: PersonInfoStringField[];
};

const PERSON_INFO_STRING_FIELDS = ["r", "u"] as const;
type PersonInfoStringField = (typeof PERSON_INFO_STRING_FIELDS)[number];

/** The nested bag inside `$client_session_props`, repairable in its own right. */
const CLIENT_SESSION_PROPS_FIELD = "props";
type RepairablePersonInfoField =
  | PersonInfoStringField
  | typeof CLIENT_SESSION_PROPS_FIELD;

/** What a repair of one record produced, before it is labelled with its key. */
type PersonInfoFieldRepair = Omit<PersistedPersonInfoRepair, "key">;

/**
 * Any object, and NOT an array — posthog-js reads these records by key, and a
 * schema declaring `r`/`u` as strings would reject the exact record this module
 * exists to repair, so those two are checked field-by-field below instead.
 *
 * Replaces the pair of `z.looseObject` schemas this module used to carry.
 * `AnalyticsProvider` mounts the guard at both app roots, including every
 * `apps/web` marketing page, so importing Zod put its whole runtime into an
 * eager client bundle to do nothing but tell objects from scalars (codex
 * review). Bundled alone on the locked version, this module measured 311,331
 * bytes minified / 61,914 gzipped with Zod and 2,192 / 1,103 without — and the
 * smaller figure now also carries the redaction below, which did not exist then.
 *
 * Behaviour-identical on the domain that can actually reach here, which is
 * whatever `JSON.parse` returned out of `localStorage`: object and null-
 * prototype object accepted, array and every primitive and `null` and
 * `undefined` rejected — each verified against the schemas before they were
 * removed, and pinned by `./posthog-persistence-repair.test.ts`.
 */
function isPersistedRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Repair every person-info field posthog-js reads as a string, keeping the rest
 * of the record byte-for-byte. Two different repairs, reported separately
 * because they describe different faults:
 *
 * A NON-STRING is dropped, and that is the outage — posthog-js calls
 * `String.prototype.search`/`.split` on these with no type check, so one bad
 * write stops capture entirely. Dropped rather than coerced: `u` is typed
 * `string | undefined` upstream and both readers handle the absent case, so
 * absence is something posthog-js can express, while `String(12345)` would be a
 * fabricated `$current_url`.
 *
 * A STRING is scrubbed of sensitive query-param values, and that is a migration
 * (whitlockk review). posthog-js masks `u` on the way IN — `getPersonInfo` runs
 * `maskQueryParams` before storing — so only a value written before ISS-8295
 * configured that masking is raw. Nothing re-masks it on the way out:
 * `getPersonPropsFromInfo` assigns the stored string straight to `$current_url`,
 * which `getSessionProps` renames to `$session_entry_url` and merges into every
 * event AFTER the per-source masking pass has already run. So a raw `state` sits
 * in localStorage sending itself to a third party on every capture, and this
 * guard — which is what revives capture on exactly those browsers — would
 * otherwise be the thing that starts it flowing again.
 *
 * `undefined` when there is nothing to repair, so a caller never rewrites a
 * healthy record.
 */
function repairPersonInfoFields(
  record: Record<string, unknown>
): PersonInfoFieldRepair | undefined {
  const dropped: DroppedPersonInfoField[] = [];
  const redacted: PersonInfoStringField[] = [];
  const value = { ...record };
  for (const field of PERSON_INFO_STRING_FIELDS) {
    const stored = value[field];
    if (stored === undefined) {
      continue;
    }
    if (typeof stored !== "string") {
      dropped.push({ field, valueType: typeof stored });
      delete value[field];
      continue;
    }
    const scrubbed = redactAnalyticsUrl(stored);
    if (scrubbed !== stored) {
      value[field] = scrubbed;
      redacted.push(field);
    }
  }
  if (dropped.length === 0 && redacted.length === 0) {
    return undefined;
  }
  return { value, dropped, redacted };
}

/**
 * An unrecognized shape is left untouched: the record was written by whatever
 * posthog-js version the browser last ran, and a release that stores something
 * else here must degrade to a no-op rather than be replaced by a guess.
 */
function repairInitialPersonInfo(
  stored: unknown
): PersistedPersonInfoRepair | undefined {
  if (!isPersistedRecord(stored)) {
    return undefined;
  }
  const repaired = repairPersonInfoFields(stored);
  if (!repaired) {
    return undefined;
  }
  return { key: PersistedPersonInfoKey.InitialPersonInfo, ...repaired };
}

/** The same pair, one level down: `{ sessionId, props: { r, u } }`. */
function repairClientSessionProps(
  stored: unknown
): PersistedPersonInfoRepair | undefined {
  if (!isPersistedRecord(stored)) {
    return undefined;
  }
  const props = stored[CLIENT_SESSION_PROPS_FIELD];
  if (!isPersistedRecord(props)) {
    return dropHazardousProps(stored, props);
  }
  const repaired = repairPersonInfoFields(props);
  if (!repaired) {
    return undefined;
  }
  return {
    key: PersistedPersonInfoKey.ClientSessionProps,
    value: { ...stored, [CLIENT_SESSION_PROPS_FIELD]: repaired.value },
    dropped: repaired.dropped,
    redacted: repaired.redacted,
  };
}

/**
 * A TRUTHY non-object `props` is the same outage one level up, and it is not
 * reached by the field sweep above because there are no fields to walk (whitlockk
 * review). `SessionPropsManager.getSetOnceProps` tests `'r' in p` after only a
 * falsiness check, and the `in` operator throws `TypeError` on a primitive — so
 * `props: 1` or `props: "bad"` kills every capture exactly like a non-string
 * `r`, and posthog-js never rewrites it because `_onSessionIdCallback` returns
 * early while the stored `sessionId` still matches.
 *
 * Deleted rather than replaced with `{}`: both leave `getSetOnceProps`
 * returning nothing, and absence is the shape posthog-js's own `!p` branch is
 * written for.
 *
 * The cases this deliberately leaves alone, because `in` answers them without
 * throwing and an untouched record is always the safer default: a falsy `props`
 * (short-circuited by `!p`), an ARRAY (an object to `in`), and an absent one.
 */
function dropHazardousProps(
  stored: Record<string, unknown>,
  props: unknown
): PersistedPersonInfoRepair | undefined {
  if (!props || typeof props === "object") {
    return undefined;
  }
  const value = { ...stored };
  delete value[CLIENT_SESSION_PROPS_FIELD];
  return {
    key: PersistedPersonInfoKey.ClientSessionProps,
    value,
    dropped: [{ field: CLIENT_SESSION_PROPS_FIELD, valueType: typeof props }],
    redacted: [],
  };
}

/**
 * Every persisted record to sweep, with the reader that understands its shape.
 * The legacy `$client_session_props` shape (`initialPathName`/`referringDomain`)
 * carries no `r`/`u`, so the field check leaves it alone without an exclusion.
 */
export const PERSISTED_PERSON_INFO_SITES: readonly {
  key: PersistedPersonInfoKey;
  repair: (stored: unknown) => PersistedPersonInfoRepair | undefined;
}[] = [
  {
    key: PersistedPersonInfoKey.ClientSessionProps,
    repair: repairClientSessionProps,
  },
  {
    key: PersistedPersonInfoKey.InitialPersonInfo,
    repair: repairInitialPersonInfo,
  },
];
