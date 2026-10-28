/**
 * @file invocation-sync-template-revision.test.ts
 * @description ISS-7980 real-SQLite characterization of the shared invocation
 * template revision bump used by every template writer.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
  AGENT_COMPONENT_INVOCATION_SYNC_STATE_SESSION_ID,
} from "../src/main/agent-sync/agent-component-invocation-sync-constants.js";
import { bumpInvocationSyncTemplateRevision } from "../src/main/database/invocation-sync-template-revision.js";
import type { DesktopPrismaReader } from "../src/main/database/prisma-client.js";
import { openTestPrisma } from "./prisma-test-utils.js";

const FIRST_BUMP_AT = "2026-08-30T12:00:00.000Z";
const SECOND_BUMP_AT = "2026-08-30T12:01:00.000Z";

test("ISS-7980: the template revision is created at one and increments atomically", async () => {
  const opened = await openTestPrisma();
  try {
    await opened.prisma.write((client) =>
      bumpInvocationSyncTemplateRevision(client, FIRST_BUMP_AT)
    );

    const created = await readTemplateRevision(opened.prisma.client);
    assert.ok(created, "the first bump must create the template state row");
    assert.equal(created.sourceSequence, 1);
    assert.equal(created.updatedAt, FIRST_BUMP_AT);
    assert.equal(
      created.externalGenerationId,
      AGENT_COMPONENT_INVOCATION_SYNC_STATE_SESSION_ID
    );

    await opened.prisma.write((client) =>
      bumpInvocationSyncTemplateRevision(client, SECOND_BUMP_AT)
    );

    const incremented = await readTemplateRevision(opened.prisma.client);
    assert.ok(
      incremented,
      "the second bump must retain the template state row"
    );
    assert.equal(incremented.sourceSequence, 2);
    assert.equal(incremented.updatedAt, SECOND_BUMP_AT);
    assert.equal(
      await opened.prisma.client.agentComponentInvocationSyncCursor.count({
        where: {
          sourceKey: AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
          externalSessionId: AGENT_COMPONENT_INVOCATION_SYNC_STATE_SESSION_ID,
        },
      }),
      1,
      "the conflict arm increments the existing sentinel instead of adding a row"
    );
  } finally {
    await opened.close();
  }
});

function readTemplateRevision(reader: DesktopPrismaReader) {
  return reader.agentComponentInvocationSyncCursor.findUnique({
    where: {
      sourceKey_externalSessionId: {
        sourceKey: AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
        externalSessionId: AGENT_COMPONENT_INVOCATION_SYNC_STATE_SESSION_ID,
      },
    },
  });
}
