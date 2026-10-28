/**
 * ISS-12211 AC4: the attribute diff behind `otlp-egress-parity-proof.ts`.
 *
 * Pure. It takes the Datadog records each keyless egress path produced for one
 * proof run (the relay `/telemetry` lane and the API `/desktop/otlp` route) and
 * reports every way they disagree. Both paths feed the same Collector, so any
 * difference here is a finding about the route, not noise to tolerate.
 *
 * Every attribute is compared except two named sets, both reported in the
 * output so the reader can see what was not compared:
 * - the run id: `app.installation.id` and `device.id`. Each path gets its own
 *   install id so its copy can be found, so their values differ by design.
 *   They are checked instead: a copy must carry its own path's id, and one
 *   that drops an id the other path's copy carries is a missing attribute.
 * - per-record identity and clock fields (ids, timestamps, duration), which no
 *   two exports share, and Datadog's own per-span retention bookkeeping.
 */

import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";

export const EgressPath = {
  Relay: "relay",
  Route: "route",
} as const;

export type EgressPath = (typeof EgressPath)[keyof typeof EgressPath];

export const ParityRecordKind = {
  Span: "span",
  Log: "log",
} as const;

export type ParityRecordKind =
  (typeof ParityRecordKind)[keyof typeof ParityRecordKind];

/** A Datadog span or log reduced to the flat attribute map the diff compares. */
export type ParityRecord = {
  kind: ParityRecordKind;
  /** Pairs one path's record with the other's: kind, resource, lifecycle event. */
  key: string;
  attributes: Record<string, string>;
};

export const ParityFindingKind = {
  /** An expected record that one path (or both) never delivered. */
  Missing: "missing",
  /** More than one record under one key on one path; pairing would be a guess. */
  Duplicate: "duplicate",
  /** An attribute one path's record carries and the other's does not. */
  AttributeMissing: "attribute_missing",
  ValueMismatch: "value_mismatch",
  /** A record that does not carry its own path's run id. */
  RunIdMismatch: "run_id_mismatch",
} as const;

export type ParityFinding =
  | { kind: typeof ParityFindingKind.Missing; key: string; path: EgressPath }
  | {
      kind: typeof ParityFindingKind.Duplicate;
      key: string;
      path: EgressPath;
      count: number;
    }
  | {
      kind: typeof ParityFindingKind.AttributeMissing;
      key: string;
      attribute: string;
      missingOn: EgressPath;
      value: string;
    }
  | {
      kind: typeof ParityFindingKind.ValueMismatch;
      key: string;
      attribute: string;
      relay: string;
      route: string;
    }
  | {
      kind: typeof ParityFindingKind.RunIdMismatch;
      key: string;
      attribute: string;
      path: EgressPath;
      expected: string;
      actual: string;
    };

export type ParityPair = {
  key: string;
  /** Attributes both copies carry with the same value. */
  identical: Record<string, string>;
};

export type ParityReport = {
  pass: boolean;
  pairs: ParityPair[];
  findings: ParityFinding[];
  notCompared: { runIdSuffixes: string[]; volatile: string[] };
};

/** Attribute-name suffixes that carry the per-path run id. */
const RUN_ID_SUFFIXES: readonly string[] = [
  TelemetryAttribute.AppInstallationId,
  TelemetryAttribute.DeviceId,
];

/**
 * Per-record identity and clock fields, as Datadog's span and log search APIs
 * name them (shapes read from `pup traces search` / `pup logs search` on
 * service:cl-desktop, 2026-10-09). `retained_by` is here too: it names the
 * Datadog retention rule that indexed the span, decided after ingest and per
 * span (the 2026-10-09 run read `retention_filter` on the error span and
 * `diversity_sampling` on its siblings), so it says nothing about the export.
 */
const VOLATILE_KEYS = new Set([
  "retained_by",
  "span_id",
  "trace_id",
  "parent_id",
  "start_timestamp",
  "end_timestamp",
  "timestamp",
  "custom.duration",
  "custom.otel.trace_id",
  "attributes.@timestamp",
  "attributes.otel.timestamp",
]);

/**
 * Reduce one Datadog search hit (`data[i]` of `pup traces search` or
 * `pup logs search`) to a {@link ParityRecord}. Nested objects flatten to dotted
 * names; each `tags` entry becomes its own `tags[<tag>]` key so a tag present
 * on one path only shows up as one missing attribute rather than as a changed
 * list.
 */
export function toParityRecord(
  kind: ParityRecordKind,
  hit: { attributes?: unknown }
): ParityRecord {
  const attributes: Record<string, string> = {};
  flattenInto(attributes, "", hit.attributes ?? {});
  const lifecycleEvent =
    attributes[`custom.${TelemetryAttribute.AppLifecycleEvent}`] ??
    attributes[`attributes.${TelemetryAttribute.AppLifecycleEvent}`];
  return {
    kind,
    key: parityKey(kind, attributes.resource_name, lifecycleEvent),
    attributes,
  };
}

/** The pairing key of a record: kind, then resource and lifecycle event when set. */
export function parityKey(
  kind: ParityRecordKind,
  resource?: string,
  lifecycleEvent?: string
): string {
  return [kind, resource, lifecycleEvent].filter(Boolean).join(" ");
}

export function diffEgressParity({
  relay,
  route,
  runIds,
  expectedKeys,
}: {
  relay: ParityRecord[];
  route: ParityRecord[];
  runIds: Record<EgressPath, string>;
  expectedKeys: readonly string[];
}): ParityReport {
  const findings: ParityFinding[] = [];
  const byPath: Record<EgressPath, Map<string, ParityRecord[]>> = {
    relay: groupByKey(relay),
    route: groupByKey(route),
  };
  const keys = [
    ...new Set([
      ...expectedKeys,
      ...byPath.relay.keys(),
      ...byPath.route.keys(),
    ]),
  ].sort();

  const pairs: ParityPair[] = [];
  for (const key of keys) {
    const chosen = pickOnePerPath(key, byPath, findings);
    for (const path of PATHS) {
      const record = chosen[path];
      if (record) {
        checkRunIds(key, path, record, runIds[path], findings);
      }
    }
    if (chosen.relay && chosen.route) {
      pairs.push(
        compareAttributes(
          key,
          chosen.relay.attributes,
          chosen.route.attributes,
          findings
        )
      );
    }
  }

  return {
    pass: findings.length === 0,
    pairs,
    findings,
    notCompared: {
      runIdSuffixes: [...RUN_ID_SUFFIXES],
      volatile: [...VOLATILE_KEYS].sort(),
    },
  };
}

const PATHS: readonly EgressPath[] = [EgressPath.Relay, EgressPath.Route];

function flattenInto(
  out: Record<string, string>,
  prefix: string,
  value: unknown
): void {
  if (Array.isArray(value)) {
    if (prefix === "tags") {
      for (const tag of value) {
        out[`tags[${String(tag)}]`] = "present";
      }
      return;
    }
    out[prefix] = JSON.stringify(value);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [childKey, child] of Object.entries(value)) {
      flattenInto(out, prefix ? `${prefix}.${childKey}` : childKey, child);
    }
    return;
  }
  out[prefix] = value === null ? "null" : String(value);
}

function groupByKey(records: ParityRecord[]): Map<string, ParityRecord[]> {
  const grouped = new Map<string, ParityRecord[]>();
  for (const record of records) {
    const list = grouped.get(record.key) ?? [];
    list.push(record);
    grouped.set(record.key, list);
  }
  return grouped;
}

function pickOnePerPath(
  key: string,
  byPath: Record<EgressPath, Map<string, ParityRecord[]>>,
  findings: ParityFinding[]
): Partial<Record<EgressPath, ParityRecord>> {
  const chosen: Partial<Record<EgressPath, ParityRecord>> = {};
  for (const path of PATHS) {
    const records = byPath[path].get(key) ?? [];
    if (records.length === 0) {
      findings.push({ kind: ParityFindingKind.Missing, key, path });
    } else if (records.length > 1) {
      findings.push({
        kind: ParityFindingKind.Duplicate,
        key,
        path,
        count: records.length,
      });
    } else {
      chosen[path] = records[0];
    }
  }
  return chosen;
}

function isRunIdAttribute(attribute: string): boolean {
  return RUN_ID_SUFFIXES.some(
    (suffix) => attribute === suffix || attribute.endsWith(`.${suffix}`)
  );
}

function checkRunIds(
  key: string,
  path: EgressPath,
  record: ParityRecord,
  expected: string,
  findings: ParityFinding[]
): void {
  for (const [attribute, actual] of Object.entries(record.attributes)) {
    if (isRunIdAttribute(attribute) && actual !== expected) {
      findings.push({
        kind: ParityFindingKind.RunIdMismatch,
        key,
        attribute,
        path,
        expected,
        actual,
      });
    }
  }
}

function compareAttributes(
  key: string,
  relay: Record<string, string>,
  route: Record<string, string>,
  findings: ParityFinding[]
): ParityPair {
  const identical: Record<string, string> = {};
  const names = [...new Set([...Object.keys(relay), ...Object.keys(route)])]
    .filter((name) => !VOLATILE_KEYS.has(name))
    .sort();
  for (const attribute of names) {
    const relayValue = relay[attribute];
    const routeValue = route[attribute];
    if (relayValue === undefined || routeValue === undefined) {
      findings.push({
        kind: ParityFindingKind.AttributeMissing,
        key,
        attribute,
        missingOn:
          relayValue === undefined ? EgressPath.Relay : EgressPath.Route,
        value: relayValue ?? routeValue ?? "",
      });
      continue;
    }
    // A run id differs by design; checkRunIds holds each copy to its own.
    if (isRunIdAttribute(attribute)) {
      continue;
    }
    if (relayValue === routeValue) {
      identical[attribute] = relayValue;
    } else {
      findings.push({
        kind: ParityFindingKind.ValueMismatch,
        key,
        attribute,
        relay: relayValue,
        route: routeValue,
      });
    }
  }
  return { key, identical };
}
