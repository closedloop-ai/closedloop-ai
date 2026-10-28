/**
 * ISS-12211 AC4: the attribute diff behind `scripts/otlp-egress-parity-proof.ts`.
 *
 * The relay fixture is the four records the relay `/telemetry` lane delivered
 * to Datadog on stage in the 2026-10-09 proof run (installation id
 * 620a2a70-…), as `pup traces search` / `pup logs search` returned them. The
 * route copy is built from it, so every case starts from a real record shape.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "vitest";
import {
  diffEgressParity,
  EgressPath,
  type ParityFinding,
  ParityFindingKind,
  type ParityRecord,
  ParityRecordKind,
  toParityRecord,
} from "../scripts/otlp-egress-parity-diff.js";
import { EXPECTED_RECORD_KEYS } from "../scripts/otlp-egress-parity-proof.js";

type Hit = { attributes?: unknown };
type PathHits = { spans: Hit[]; logs: Hit[] };

const RELAY_RUN_ID = "620a2a70-8516-43e7-a35d-b3419be83639";
const ROUTE_RUN_ID = "c34b8025-853e-40c0-afeb-a6fe0694721c";
const ROUTE_CLOCK = "2026-10-09T21:14:30.000Z";

const relayHits: PathHits = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "fixtures/otlp-egress-parity/relay-hits.json"),
    "utf8"
  )
);

describe("toParityRecord", () => {
  test("keys a span by resource and lifecycle event, and flattens custom attributes", () => {
    const records = relayHits.spans.map((hit) =>
      toParityRecord(ParityRecordKind.Span, hit)
    );
    assert.deepEqual(records.map((record) => record.key).sort(), [
      "span app.lifecycle start",
      "span cl-desktop",
      "span exception",
    ]);
    const start = records.find(
      (record) => record.key === "span app.lifecycle start"
    );
    assert.equal(start?.attributes["custom.app.installation.id"], RELAY_RUN_ID);
    assert.equal(start?.attributes["tags[source:apm]"], "present");
  });

  test("keys the heartbeat log by its lifecycle event", () => {
    const [heartbeat] = relayHits.logs.map((hit) =>
      toParityRecord(ParityRecordKind.Log, hit)
    );
    assert.equal(heartbeat?.key, "log heartbeat");
    assert.equal(
      heartbeat?.attributes["attributes.app.lifecycle.event"],
      "heartbeat"
    );
    assert.equal(heartbeat?.attributes["tags[env:stage]"], "present");
  });
});

describe("diffEgressParity", () => {
  test("a route copy that differs only in run id and per-record fields is parity", () => {
    const report = diff(relayRecords(), routeRecords());

    assert.deepEqual(report.findings, []);
    assert.equal(report.pass, true);
    assert.deepEqual(
      report.pairs.map((pair) => pair.key),
      [...EXPECTED_RECORD_KEYS].sort()
    );
    const exception = report.pairs.find(
      (pair) => pair.key === "span exception"
    );
    assert.equal(exception?.identical["custom.app.exception.origin"], "main");
    assert.equal(exception?.identical.status, "error");
    assert.equal(exception?.identical["custom.app.installation.id"], undefined);
  });

  test("a value that differs between the paths is a finding naming both values", () => {
    const report = diff(
      relayRecords(),
      routeRecords({
        editSpan: (hit) => setPath(hit, ["attributes", "env"], "prod"),
      })
    );

    assert.equal(report.pass, false);
    assert.deepEqual(
      onlyKind(report.findings, ParityFindingKind.ValueMismatch).map(
        (finding) => [
          finding.key,
          finding.attribute,
          finding.relay,
          finding.route,
        ]
      ),
      [
        ["span app.lifecycle start", "env", "stage", "prod"],
        ["span cl-desktop", "env", "stage", "prod"],
        ["span exception", "env", "stage", "prod"],
      ]
    );
  });

  test("an attribute one path's copy lacks is a finding naming that path", () => {
    const report = diff(
      relayRecords(),
      routeRecords({
        editLog: (hit) =>
          deletePath(hit, ["attributes", "attributes", "app", "agent_monitor"]),
      })
    );

    assert.deepEqual(
      onlyKind(report.findings, ParityFindingKind.AttributeMissing),
      [
        {
          kind: ParityFindingKind.AttributeMissing,
          key: "log heartbeat",
          attribute: "attributes.app.agent_monitor.runtime_status",
          missingOn: EgressPath.Route,
          value: "ready",
        },
      ]
    );
  });

  test("an expected record neither path delivered is reported for both paths", () => {
    const withoutRoot = (records: ParityRecord[]) =>
      records.filter((record) => record.key !== "span cl-desktop");
    const report = diff(
      withoutRoot(relayRecords()),
      withoutRoot(routeRecords())
    );

    assert.deepEqual(onlyKind(report.findings, ParityFindingKind.Missing), [
      {
        kind: ParityFindingKind.Missing,
        key: "span cl-desktop",
        path: EgressPath.Relay,
      },
      {
        kind: ParityFindingKind.Missing,
        key: "span cl-desktop",
        path: EgressPath.Route,
      },
    ]);
    assert.equal(report.pass, false);
  });

  test("a route that delivered nothing fails with every expected record missing on the route", () => {
    const report = diff(relayRecords(), []);

    assert.deepEqual(
      onlyKind(report.findings, ParityFindingKind.Missing).map((finding) => [
        finding.key,
        finding.path,
      ]),
      [...EXPECTED_RECORD_KEYS].sort().map((key) => [key, EgressPath.Route])
    );
    assert.deepEqual(report.pairs, []);
  });

  test("two copies under one key on one path are a duplicate, not a guessed pair", () => {
    const route = routeRecords();
    const heartbeat = route.find((record) => record.key === "log heartbeat");
    assert.ok(heartbeat);
    const report = diff(relayRecords(), [...route, heartbeat]);

    assert.deepEqual(onlyKind(report.findings, ParityFindingKind.Duplicate), [
      {
        kind: ParityFindingKind.Duplicate,
        key: "log heartbeat",
        path: EgressPath.Route,
        count: 2,
      },
    ]);
    assert.equal(
      report.pairs.some((pair) => pair.key === "log heartbeat"),
      false
    );
  });

  test("a copy that drops a run id the other path's copy carries is a missing attribute", () => {
    const report = diff(
      relayRecords(),
      routeRecords({
        editLog: (hit) =>
          deletePath(hit, ["attributes", "attributes", "device"]),
      })
    );

    assert.deepEqual(report.findings, [
      {
        kind: ParityFindingKind.AttributeMissing,
        key: "log heartbeat",
        attribute: "attributes.device.id",
        missingOn: EgressPath.Route,
        value: RELAY_RUN_ID,
      },
    ]);
  });

  test("a copy carrying another path's run id is a finding for that attribute only", () => {
    const report = diff(
      relayRecords(),
      routeRecords({
        editLog: (hit) =>
          setPath(
            hit,
            ["attributes", "attributes", "app", "installation", "id"],
            RELAY_RUN_ID
          ),
      })
    );

    assert.deepEqual(
      onlyKind(report.findings, ParityFindingKind.RunIdMismatch),
      [
        {
          kind: ParityFindingKind.RunIdMismatch,
          key: "log heartbeat",
          attribute: "attributes.app.installation.id",
          path: EgressPath.Route,
          expected: ROUTE_RUN_ID,
          actual: RELAY_RUN_ID,
        },
      ]
    );
  });
});

function diff(relay: ParityRecord[], route: ParityRecord[]) {
  return diffEgressParity({
    relay,
    route,
    runIds: { relay: RELAY_RUN_ID, route: ROUTE_RUN_ID },
    expectedKeys: EXPECTED_RECORD_KEYS,
  });
}

function relayRecords(): ParityRecord[] {
  return toRecords(relayHits);
}

/**
 * The relay fixture re-issued as the route's copy: its own run id, fresh
 * per-record ids and clock, and a different Datadog retention rule, as a second
 * export of the same telemetry can carry.
 */
function routeRecords({
  editSpan,
  editLog,
}: {
  editSpan?: (hit: Hit) => void;
  editLog?: (hit: Hit) => void;
} = {}): ParityRecord[] {
  const route = JSON.parse(
    JSON.stringify(relayHits).replaceAll(RELAY_RUN_ID, ROUTE_RUN_ID)
  ) as PathHits;
  for (const hit of route.spans) {
    for (const field of ["span_id", "parent_id", "trace_id"]) {
      setPath(hit, ["attributes", field], "route-copy");
    }
    setPath(hit, ["attributes", "custom", "otel", "trace_id"], "route-copy");
    setPath(hit, ["attributes", "start_timestamp"], ROUTE_CLOCK);
    setPath(hit, ["attributes", "end_timestamp"], ROUTE_CLOCK);
    setPath(hit, ["attributes", "retained_by"], "diversity_sampling");
    editSpan?.(hit);
  }
  for (const hit of route.logs) {
    setPath(hit, ["attributes", "timestamp"], ROUTE_CLOCK);
    setPath(hit, ["attributes", "attributes", "@timestamp"], ROUTE_CLOCK);
    setPath(hit, ["attributes", "attributes", "otel", "timestamp"], "1");
    editLog?.(hit);
  }
  return toRecords(route);
}

function toRecords(hits: PathHits): ParityRecord[] {
  return [
    ...hits.spans.map((hit) => toParityRecord(ParityRecordKind.Span, hit)),
    ...hits.logs.map((hit) => toParityRecord(ParityRecordKind.Log, hit)),
  ];
}

function onlyKind<K extends ParityFinding["kind"]>(
  findings: ParityFinding[],
  kind: K
): Extract<ParityFinding, { kind: K }>[] {
  return findings.filter(
    (finding): finding is Extract<ParityFinding, { kind: K }> =>
      finding.kind === kind
  );
}

function setPath(target: unknown, path: string[], value: unknown): void {
  let node = target as Record<string, unknown>;
  for (const segment of path.slice(0, -1)) {
    node = node[segment] as Record<string, unknown>;
  }
  node[path.at(-1) as string] = value;
}

function deletePath(target: unknown, path: string[]): void {
  let node = target as Record<string, unknown>;
  for (const segment of path.slice(0, -1)) {
    node = node[segment] as Record<string, unknown>;
  }
  delete node[path.at(-1) as string];
}
