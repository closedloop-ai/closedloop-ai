/**
 * ISS-12251 (PLN-2176 T-3.4, D-6) — rename is authorized to the session's
 * assignee or an org admin, and to nobody else.
 *
 * The fixture separates the people the old rule conflated: the session was
 * uploaded and created by one user (`compute_targets.user_id` = `created_by_id`)
 * and assigned to another. So the creator is the user the retired
 * `session_detail.user_id` predicate would have admitted, and refusing them is
 * what proves the rule moved.
 */
import { Status } from "@repo/api/src/types/result";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCommittedTestOrganizationTracker,
  createTestSessionDetail,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { sessionRenameService } from "./session-rename-service";

// The rename's search retitle is handed to `waitUntil`; collect it so each case
// settles its own work before the organization is torn down.
const scheduled = vi.hoisted((): Promise<unknown>[] => []);
vi.mock("@vercel/functions", () => ({
  waitUntil: (work: Promise<unknown>) => {
    scheduled.push(work);
  },
}));

const describeIfDb = keys().DATABASE_URL ? describe : describe.skip;
const organizations = createCommittedTestOrganizationTracker();

type Fixture = {
  organizationId: string;
  artifactId: string;
  assignee: string;
  creator: string;
  member: string;
  admin: string;
};

async function seed(): Promise<Fixture> {
  const organizationId = await organizations.create();
  const [assignee, creator, member, admin] = await Promise.all(
    [0, 1, 2, 3].map(() => createTestUser(organizationId))
  );
  const artifactId = await createTestSessionDetail({
    organizationId,
    userId: creator.id,
    label: "rename-assignee",
  });
  await withDb((db) =>
    db.artifact.update({
      where: { id: artifactId },
      data: { assigneeId: assignee.id, createdById: creator.id },
      select: { id: true },
    })
  );
  return {
    organizationId,
    artifactId,
    assignee: assignee.id,
    creator: creator.id,
    member: member.id,
    admin: admin.id,
  };
}

function renameAs(
  fixture: Fixture,
  actorUserId: string,
  actorIsOrgAdmin: boolean,
  name: string
) {
  return sessionRenameService.rename({
    id: fixture.artifactId,
    organizationId: fixture.organizationId,
    actorUserId,
    authMethod: "session",
    actorIsOrgAdmin,
    name,
  });
}

async function storedName(fixture: Fixture): Promise<string | null> {
  const row = await withDb((db) =>
    db.sessionDetail.findUniqueOrThrow({
      where: { artifactId: fixture.artifactId },
      select: { nameOverride: true },
    })
  );
  return row.nameOverride;
}

describeIfDb("session rename authorization on the assignee (ISS-12251)", () => {
  afterEach(async () => {
    await Promise.allSettled(scheduled.splice(0));
    await organizations.cleanup();
  });

  it("lets the assignee rename a session they did not create", async () => {
    const fixture = await seed();

    expect(
      await renameAs(fixture, fixture.assignee, false, "By assignee")
    ).toEqual({ ok: true, value: undefined });
    expect(await storedName(fixture)).toBe("By assignee");
  });

  it("refuses the creator and uploader once someone else is the assignee", async () => {
    const fixture = await seed();

    expect(
      await renameAs(fixture, fixture.creator, false, "By creator")
    ).toEqual({ ok: false, error: Status.Forbidden });
    expect(await storedName(fixture)).toBeNull();
  });

  it("lets an org admin who is neither assignee nor creator rename it", async () => {
    const fixture = await seed();

    expect(await renameAs(fixture, fixture.admin, true, "By admin")).toEqual({
      ok: true,
      value: undefined,
    });
    expect(await storedName(fixture)).toBe("By admin");
  });

  it("waits out an uncommitted reassignment and authorizes against the committed assignee", async () => {
    const fixture = await seed();
    let releaseReassign = (): void => undefined;
    const reassignReleased = new Promise<void>((resolve) => {
      releaseReassign = resolve;
    });
    let markRowLocked = (): void => undefined;
    const rowLocked = new Promise<void>((resolve) => {
      markRowLocked = resolve;
    });
    const reassign = withDb.tx(async (tx) => {
      await tx.artifact.update({
        where: { id: fixture.artifactId },
        data: { assigneeId: fixture.member },
        select: { id: true },
      });
      markRowLocked();
      await reassignReleased;
    });
    await rowLocked;

    const rename = renameAs(fixture, fixture.assignee, false, "Raced");
    const settled = { done: false };
    const first = await Promise.race([
      rename.then(() => RaceWinner.Rename),
      waitForRenameLockWait(settled),
    ]);
    settled.done = true;
    releaseReassign();
    await reassign;

    expect(first).toBe(RaceWinner.BlockedOnLock);
    expect(await rename).toEqual({ ok: false, error: Status.Forbidden });
    expect(await storedName(fixture)).toBeNull();
  });
});

const RaceWinner = {
  Rename: "rename",
  BlockedOnLock: "blocked-on-lock",
  GaveUp: "gave-up",
} as const;
type RaceWinner = (typeof RaceWinner)[keyof typeof RaceWinner];

const LOCK_WAIT_POLL_ATTEMPTS = 200;
const LOCK_WAIT_POLL_INTERVAL_MS = 25;

/**
 * Resolves once a backend is waiting on a row lock inside the rename's locking
 * read, or reports `GaveUp` after a bounded poll. Never rejects, so a rename
 * that wins the race leaves nothing unhandled behind.
 */
async function waitForRenameLockWait(settled: {
  done: boolean;
}): Promise<RaceWinner> {
  for (let attempt = 0; attempt < LOCK_WAIT_POLL_ATTEMPTS; attempt += 1) {
    if (settled.done) {
      return RaceWinner.GaveUp;
    }
    const [row] = await withDb(
      (db) =>
        db.$queryRaw<{ waiting: bigint }[]>`
        SELECT count(*) AS "waiting"
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND wait_event_type = 'Lock'
          AND query LIKE '%FOR NO KEY UPDATE%'
      `
    );
    if (row && row.waiting > 0n) {
      return RaceWinner.BlockedOnLock;
    }
    await new Promise((resolve) =>
      setTimeout(resolve, LOCK_WAIT_POLL_INTERVAL_MS)
    );
  }
  return RaceWinner.GaveUp;
}
