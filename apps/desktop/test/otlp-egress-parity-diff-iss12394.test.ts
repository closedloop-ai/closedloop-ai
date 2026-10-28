/**
 * ISS-12394: `otlp-egress-parity-diff.ts` branches the sibling suite leaves
 * open: a hit with no attributes, a non-`tags` array value, and an attribute
 * missing on each side of a pair.
 */
import { describe, expect, it } from "vitest";
import {
  diffEgressParity,
  EgressPath,
  ParityFindingKind,
  ParityRecordKind,
  toParityRecord,
} from "../scripts/otlp-egress-parity-diff.js";

const RELAY_RUN_ID = "620a2a70-8516-43e7-a35d-b3419be83639";
const ROUTE_RUN_ID = "c34b8025-853e-40c0-afeb-a6fe0694721c";

describe("toParityRecord", () => {
  it("treats a hit with no attributes as an empty record keyed by kind alone", () => {
    expect(toParityRecord(ParityRecordKind.Log, {})).toEqual({
      kind: ParityRecordKind.Log,
      key: ParityRecordKind.Log,
      attributes: {},
    });
  });

  it("serializes a non-tags array as JSON but splits tags into keys", () => {
    const record = toParityRecord(ParityRecordKind.Span, {
      attributes: { list: [1, "a"], tags: ["env:stage"] },
    });
    expect(record.attributes).toEqual({
      list: '[1,"a"]',
      "tags[env:stage]": "present",
    });
  });
});

describe("diffEgressParity attribute missing on one side", () => {
  it("names the path that lacks the attribute and carries the other side's value", () => {
    const relay = toParityRecord(ParityRecordKind.Log, {
      attributes: { onlyRelay: "r" },
    });
    const route = toParityRecord(ParityRecordKind.Log, {
      attributes: { onlyRoute: "q" },
    });
    const report = diffEgressParity({
      relay: [relay],
      route: [route],
      runIds: { relay: RELAY_RUN_ID, route: ROUTE_RUN_ID },
      expectedKeys: [],
    });
    expect(report.pass).toBe(false);
    expect(report.findings).toEqual([
      {
        kind: ParityFindingKind.AttributeMissing,
        key: ParityRecordKind.Log,
        attribute: "onlyRelay",
        missingOn: EgressPath.Route,
        value: "r",
      },
      {
        kind: ParityFindingKind.AttributeMissing,
        key: ParityRecordKind.Log,
        attribute: "onlyRoute",
        missingOn: EgressPath.Relay,
        value: "q",
      },
    ]);
  });
});
