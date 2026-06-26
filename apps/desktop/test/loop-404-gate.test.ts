/**
 * Unit tests for apps/desktop/src/main/loop-404-gate.ts
 *
 * Covers:
 *   - marking an endpoint disabled
 *   - checking disabled state (returns false before mark, true after)
 *   - independence between server URLs (different servers do not share state)
 *   - independence between endpoint paths on the same server
 *   - process-memory-only semantics (no disk persistence — verified by
 *     resetting via resetAllGates() and confirming state is gone)
 */

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  isEndpointDisabled,
  markEndpointDisabled,
  resetAllGates,
} from "../src/main/loop-404-gate.js";

afterEach(() => {
  // Restore clean in-memory state between tests so each test is independent.
  resetAllGates();
});

test("isEndpointDisabled returns false before any mark", () => {
  assert.equal(
    isEndpointDisabled("https://api.example.com", "/refresh-token"),
    false
  );
});

test("markEndpointDisabled flips state to true and is idempotent on repeat marks", () => {
  markEndpointDisabled("https://api.example.com", "/heartbeat");
  markEndpointDisabled("https://api.example.com", "/heartbeat");
  assert.equal(
    isEndpointDisabled("https://api.example.com", "/heartbeat"),
    true
  );
});

test("each (server, path) pair has independent disabled state", () => {
  markEndpointDisabled("https://api.server-a.com", "/heartbeat");
  markEndpointDisabled("https://api.server-b.com", "/refresh-token");

  assert.equal(
    isEndpointDisabled("https://api.server-a.com", "/heartbeat"),
    true
  );
  assert.equal(
    isEndpointDisabled("https://api.server-b.com", "/heartbeat"),
    false,
    "/heartbeat was only disabled on server-a"
  );
  assert.equal(
    isEndpointDisabled("https://api.server-a.com", "/refresh-token"),
    false,
    "/refresh-token was only disabled on server-b"
  );
  assert.equal(
    isEndpointDisabled("https://api.server-b.com", "/refresh-token"),
    true
  );
});

test("resetAllGates clears state and the gate can be re-populated afterwards", () => {
  markEndpointDisabled("https://api.server-a.com", "/refresh-token");
  markEndpointDisabled("https://api.server-b.com", "/heartbeat");

  resetAllGates();

  assert.equal(
    isEndpointDisabled("https://api.server-a.com", "/refresh-token"),
    false,
    "state should be cleared after resetAllGates"
  );
  assert.equal(
    isEndpointDisabled("https://api.server-b.com", "/heartbeat"),
    false,
    "state should be cleared after resetAllGates"
  );

  // Re-mark to confirm the in-memory store still works after reset.
  markEndpointDisabled("https://api.server-a.com", "/refresh-token");
  assert.equal(
    isEndpointDisabled("https://api.server-a.com", "/refresh-token"),
    true
  );
});
