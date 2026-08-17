/**
 * ISS-5992: the desktop's decompressed-size CHUNK TARGET and the server's
 * enforced CEILING are two constants, not one, and the gap between them is the
 * safety margin for independently deployed halves.
 *
 * The failure this pins is a deploy-order bug, not a logic bug, so it cannot be
 * caught by exercising either half alone: if a future edit collapses the two
 * back into one value (or inverts them), a desktop build would start producing
 * payloads sized against a ceiling the deployed server does not yet enforce.
 * Those are rejected with `Invalid compressed body`, which the desktop maps to
 * `validation_failed` and DEAD-LETTERS — permanent loss of a real session.
 *
 * Only one direction is safe: producer target <= server ceiling. The server
 * being strictly more permissive than any client, old or new, is what makes the
 * raise safe in either deploy order.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SYNC_DECOMPRESSED_BYTE_CEILING,
  SYNC_DECOMPRESSED_CHUNK_TARGET_BYTES,
} from "@repo/api/src/types/agent-session-sync-limits";
import { prepareAgentSessionPayload } from "../src/main/agent-sync/agent-session-sync-payload.js";

describe("ISS-5992: decompressed-size skew margin", () => {
  it("keeps the producer target at or below the server ceiling", () => {
    assert.ok(
      SYNC_DECOMPRESSED_CHUNK_TARGET_BYTES <= SYNC_DECOMPRESSED_BYTE_CEILING,
      "the desktop must never chunk to a larger size than the server accepts"
    );
  });

  it("leaves headroom rather than sitting exactly on the ceiling", () => {
    // Equal values would technically pass the check above while removing the
    // margin that makes an independent deploy safe in BOTH orders.
    assert.ok(
      SYNC_DECOMPRESSED_CHUNK_TARGET_BYTES < SYNC_DECOMPRESSED_BYTE_CEILING,
      "collapsing the two constants removes the deploy-skew margin"
    );
  });

  it("chunks a payload against the producer target, not the raised ceiling", () => {
    // Behavioural, not a constant read: a session sized BETWEEN the target and
    // the ceiling must still be split. If the chunker were re-pointed at the
    // raised ceiling it would ship this whole, which is exactly the payload an
    // undeployed server would dead-letter.
    const between = Math.floor(
      (SYNC_DECOMPRESSED_CHUNK_TARGET_BYTES + SYNC_DECOMPRESSED_BYTE_CEILING) /
        2
    );
    const session = {
      externalSessionId: "iss-5992-oversized",
      name: "Oversized session",
      status: "active",
      harness: "claude",
      cwd: "/tmp/wt",
      model: "claude-opus-4",
      startedAt: "2026-06-10T10:00:00.000Z",
      updatedAt: "2026-06-10T11:00:00.000Z",
      agents: [],
      tokenUsageByModel: [],
      events: [
        {
          externalEventId: "e1",
          eventType: "PostToolUse",
          createdAt: "2026-07-10T00:00:00.000Z",
          toolName: "a".repeat(between),
        },
      ],
    } as unknown as Parameters<typeof prepareAgentSessionPayload>[0];

    const prepared = prepareAgentSessionPayload(session, 256 * 1024);

    assert.notEqual(
      prepared.kind,
      "session",
      "a session larger than the producer target must not ship whole"
    );
  });
});
