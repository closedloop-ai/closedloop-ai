/**
 * Table-driven tests for classifyLoopStatus.
 *
 * Covers all disposition paths:
 *   - terminal: 401 (unauthorized), 404 (not_found), 410 (gone),
 *               null+timed_out (timed_out)
 *   - transient: 503 (server_error), null+null (network_error)
 *   - live: 200+active, null+active
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  type ClassifierProvenanceContext,
  classifyLoopStatus,
  type LoopStatusDisposition,
} from "../src/main/loop-status-classifier.js";

type ClassifyCase = {
  label: string;
  httpStatus: number | null;
  cloudKind: string | null;
  provenanceCtx?: ClassifierProvenanceContext;
  expected: LoopStatusDisposition;
};

const cases: ClassifyCase[] = [
  // --- Terminal paths ---
  {
    label: "401 → terminal(unauthorized)",
    httpStatus: 401,
    cloudKind: null,
    expected: { kind: "terminal", reason: "unauthorized" },
  },
  {
    label: "404 → terminal(not_found)",
    httpStatus: 404,
    cloudKind: null,
    expected: { kind: "terminal", reason: "not_found" },
  },
  {
    label: "410 → terminal(gone)",
    httpStatus: 410,
    cloudKind: null,
    expected: { kind: "terminal", reason: "gone" },
  },
  {
    label: "null+timed_out → terminal(timed_out)",
    httpStatus: null,
    cloudKind: "timed_out",
    expected: { kind: "terminal", reason: "timed_out" },
  },
  // Explicit TIMED_OUT kind takes precedence even when an HTTP status is present.
  {
    label:
      "200+timed_out → terminal(timed_out) (cloudKind wins over httpStatus)",
    httpStatus: 200,
    cloudKind: "timed_out",
    expected: { kind: "terminal", reason: "timed_out" },
  },

  // --- Transient paths ---
  {
    label: "503 → transient(server_error)",
    httpStatus: 503,
    cloudKind: null,
    expected: { kind: "transient", reason: "server_error" },
  },
  {
    label: "null+null → transient(network_error)",
    httpStatus: null,
    cloudKind: null,
    expected: { kind: "transient", reason: "network_error" },
  },

  // --- Live path ---
  {
    label: "200+active → live",
    httpStatus: 200,
    cloudKind: "active",
    expected: { kind: "live" },
  },
  // Boot-recovery reattach threads no HTTP status for healthy loops; an
  // explicit "active" kind must still resolve to live, not network_error.
  {
    label: "null+active → live (boot-recovery healthy reattach)",
    httpStatus: null,
    cloudKind: "active",
    expected: { kind: "live" },
  },

  // --- Provenance-aware 401 classification (T-1.2) ---

  // (a) 401 with DESKTOP_MANAGED provenance and PoP available → pop_fallback
  {
    label: "401 + DESKTOP_MANAGED + PoP available → pop_fallback(unauthorized)",
    httpStatus: 401,
    cloudKind: null,
    provenanceCtx: { provenance: "DESKTOP_MANAGED", popAvailable: true },
    expected: { kind: "pop_fallback", reason: "unauthorized" },
  },
  // (b) 401 with USER_CREATED provenance → still terminal
  {
    label: "401 + USER_CREATED → terminal(unauthorized)",
    httpStatus: 401,
    cloudKind: null,
    provenanceCtx: { provenance: "USER_CREATED", popAvailable: false },
    expected: { kind: "terminal", reason: "unauthorized" },
  },
  // (c) 401 with DESKTOP_MANAGED but no PoP → still terminal
  {
    label: "401 + DESKTOP_MANAGED + PoP unavailable → terminal(unauthorized)",
    httpStatus: 401,
    cloudKind: null,
    provenanceCtx: { provenance: "DESKTOP_MANAGED", popAvailable: false },
    expected: { kind: "terminal", reason: "unauthorized" },
  },
  // (d) Non-401 terminal codes are unaffected by provenance. The provenance
  // check lives entirely inside the `httpStatus === 401` branch, so a single
  // non-401 representative proves provenance is never consulted for 404/410/
  // timed_out (those codes already have dedicated no-provenance coverage above).
  {
    label:
      "404 + DESKTOP_MANAGED + PoP available → terminal(not_found) (provenance irrelevant)",
    httpStatus: 404,
    cloudKind: null,
    provenanceCtx: { provenance: "DESKTOP_MANAGED", popAvailable: true },
    expected: { kind: "terminal", reason: "not_found" },
  },
  // (e) 401 with no provenance context (backward compatibility) → terminal
  {
    label:
      "401 + no provenance context → terminal(unauthorized) (backward compatible)",
    httpStatus: 401,
    cloudKind: null,
    // provenanceCtx omitted
    expected: { kind: "terminal", reason: "unauthorized" },
  },
];

describe("classifyLoopStatus", () => {
  for (const {
    label,
    httpStatus,
    cloudKind,
    provenanceCtx,
    expected,
  } of cases) {
    test(label, () => {
      const result = classifyLoopStatus(httpStatus, cloudKind, provenanceCtx);
      assert.deepEqual(result, expected);
    });
  }
});
