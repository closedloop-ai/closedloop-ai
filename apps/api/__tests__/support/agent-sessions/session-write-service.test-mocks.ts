/**
 * The transaction double every `sessionWriteService` suite drives.
 *
 * Support rather than co-located state (`apps/api/AGENTS.md` — Test-Support
 * Placement) because ISS-9465 split those suites in two: the bulk-assign half
 * and the create/update half now live in separate files, and a second copy of
 * this fake would be free to drift into agreeing with a bug one half has and
 * the other does not.
 *
 * The org predicate is decided from the values each call BINDS rather than
 * asserted from an argument list, so dropping `organizationId` or `type` from a
 * production predicate leaves the fake with nothing to match and reds the
 * mixed-set cases.
 */
import { ArtifactType } from "@repo/api/src/types/artifact";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { type Mock, vi } from "vitest";

/**
 * What the `Prisma.sql` double each suite installs produces. Only the two parts
 * the fake reads: the literal chunks, which say WHICH table the statement hit,
 * and the bound values, which say which rows and under which org predicate.
 */
export type FakeSql = { strings: string[]; values: unknown[] };

export const ORG_ID = "11111111-1111-4111-8111-111111111111";
export const OTHER_ORG_ID = "11111111-1111-4111-8111-111111111112";
export const ACTOR_ID = "22222222-2222-4222-8222-222222222221";
export const OWNER_ID = "22222222-2222-4222-8222-222222222222";
export const FOREIGN_OWNER_ID = "22222222-2222-4222-8222-222222222223";
export const PROJECT_ID = "33333333-3333-4333-8333-333333333331";
/** A second project of the same org, so a prior value can differ per row. */
export const OTHER_PROJECT_ID = "33333333-3333-4333-8333-333333333334";
export const FOREIGN_PROJECT_ID = "33333333-3333-4333-8333-333333333332";
export const COMPUTE_TARGET_ID = "44444444-4444-4444-8444-444444444441";
export const FOREIGN_COMPUTE_TARGET_ID = "44444444-4444-4444-8444-444444444442";
export const SESSION_A = "55555555-5555-4555-8555-555555555551";
export const SESSION_B = "55555555-5555-4555-8555-555555555552";
/** Belongs to OTHER_ORG_ID — the unauthorized id in the mixed-set cases. */
export const FOREIGN_SESSION = "55555555-5555-4555-8555-555555555553";
/** Exists in no org at all — the row-ABSENT case. */
export const DELETED_SESSION = "55555555-5555-4555-8555-555555555554";
/**
 * In the CALLER'S OWN org and NOT a SESSION artifact, so a write scoped only by
 * organization would reassign it (davetho, PR #6330).
 */
export const NON_SESSION_ARTIFACT = "55555555-5555-4555-8555-555555555555";

export type WhereShape = Record<string, unknown>;

/**
 * Annotated rather than inferred: an inferred `vi.fn()` names `@vitest/spy`'s
 * internal `Procedure`, which `tsc` refuses to write into a declaration
 * (TS2883).
 */
export const mocks: {
  sessionOrgById: Map<string, string>;
  artifactTypeById: Map<string, string>;
  projectOrgById: Map<string, string>;
  projectIdBySession: Map<string, string | null>;
  ownerIdBySession: Map<string, string | null>;
  /**
   * artifactId -> the row `lockSessionArtifactRow` reads under `FOR NO KEY
   * UPDATE` for the ISS-9486 optimistic guards. Absent means the raw lookup
   * matches no row, the same "org/type predicate excluded it" shape the other
   * fakes use — the guard tests decide `artifact === null` from this map
   * rather than from a canned reply. The row's assignee is read from
   * {@link ownerIdBySession}, so both locks report one Owner per session.
   */
  lockedArtifactRowById: Map<
    string,
    { status: string; projectId: string | null }
  >;
  artifactFindMany: Mock;
  queryRaw: Mock;
  userOrgById: Map<string, string>;
  computeTargetOrgById: Map<string, string>;
  existingSessionDetail: { artifactId: string } | null;
  existingStoredExternalKey: string | null;
  lookedUpExternalKeys: string[];
  txRolledBack: boolean;
  artifactUpdateMany: Mock;
  sessionDetailCreate: Mock;
  artifactFindFirst: Mock;
  listSessionsByArtifactIds: Mock;
  generateSlug: Mock;
  acquireSessionAdvisoryLocks: Mock;
  callOrder: string[];
} = {
  /** artifactId -> organizationId, for the fake org-scoped predicates below. */
  sessionOrgById: new Map<string, string>(),
  /**
   * artifactId -> `artifact.type`. Separate from the org index so a same-org
   * artifact of another type exists. Interpreting `type` at this seam is what
   * lets the tests below decide whether production put it in the predicate.
   */
  artifactTypeById: new Map<string, string>(),
  projectOrgById: new Map<string, string>(),
  /**
   * artifactId -> the project / owner (artifact assignee) it holds BEFORE a
   * write, which is what the locked pre-read inside the write transaction
   * reports (ISS-9465). Kept apart from the org index so a case can move a
   * row's prior value without changing who can write it. The bulk lock finds a
   * row only when its id is in `projectIdBySession`.
   */
  projectIdBySession: new Map<string, string | null>(),
  ownerIdBySession: new Map<string, string | null>(),
  lockedArtifactRowById: new Map<
    string,
    { status: string; projectId: string | null }
  >(),
  artifactFindMany: vi.fn(),
  queryRaw: vi.fn(),
  userOrgById: new Map<string, string>(),
  computeTargetOrgById: new Map<string, string>(),
  existingSessionDetail: null as { artifactId: string } | null,
  /**
   * The index key {@link existingSessionDetail} is STORED under. `null` means
   * "answer for any key", which is what the cases that are not about index-key
   * resolution want.
   */
  existingStoredExternalKey: null as string | null,
  /** Every `externalSessionId` a lookup asked for, in issue order. */
  lookedUpExternalKeys: [] as string[],
  txRolledBack: false,
  artifactUpdateMany: vi.fn(),
  sessionDetailCreate: vi.fn(),
  artifactFindFirst: vi.fn(),
  listSessionsByArtifactIds: vi.fn(),
  generateSlug: vi.fn(),
  acquireSessionAdvisoryLocks: vi.fn(),
  /** Every tx call in issue order, so orderings the code depends on are testable. */
  callOrder: [] as string[],
};

/**
 * The DB seam. Each `where` is interpreted the way Postgres would: an
 * organization scope in the predicate EXCLUDES rows from another org, so the
 * mixed-set and cross-org cases are decided by the predicate the production
 * code actually built rather than by a canned count. A mock that returned the
 * same count regardless of its `where` would prove nothing about the org filter.
 *
 * `type` is interpreted the same way, and for the same reason: dropping it from
 * a predicate must COST a row here, or a test asserting the SESSION scope would
 * stay green against a predicate that scopes only by org.
 */
function matchesOrg(
  where: WhereShape,
  ids: string[],
  index: Map<string, string>
): number {
  const organizationId = where.organizationId as string | undefined;
  const type = where.type as string | undefined;
  return ids.filter((id) => {
    const owningOrg = index.get(id);
    if (owningOrg === undefined) {
      return false;
    }
    if (organizationId !== undefined && owningOrg !== organizationId) {
      return false;
    }
    return type === undefined || mocks.artifactTypeById.get(id) === type;
  }).length;
}

function idsFromWhere(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  const inClause = (value as { in?: string[] } | undefined)?.in;
  return inClause ?? [];
}

/** Record an issue-ordered trace so ordering the code depends on is assertable. */
function traced<T>(step: string, value: T): T {
  mocks.callOrder.push(step);
  return value;
}

export const tx: Record<string, unknown> = {
  $queryRaw: (...args: unknown[]) => mocks.queryRaw(...args),
  artifact: {
    updateMany: mocks.artifactUpdateMany,
    findFirst: mocks.artifactFindFirst,
    findMany: mocks.artifactFindMany,
  },
  sessionDetail: {
    create: mocks.sessionDetailCreate,
    // Keyed on the `externalSessionId` the predicate actually asked for. A
    // findUnique that answered the same regardless would prove nothing about
    // WHICH index key the create looks a row up under, which is the whole of the
    // ISS-8069 / ISS-8254 contract this path inherits from the desktop ingest.
    findUnique: vi.fn(({ where }: { where: WhereShape }) => {
      const key = (
        where.computeTargetId_externalSessionId as {
          externalSessionId: string;
        }
      ).externalSessionId;
      mocks.lookedUpExternalKeys.push(key);
      const stored = mocks.existingStoredExternalKey;
      const hit = stored === null || stored === key;
      return Promise.resolve(
        traced("existing-lookup", hit ? mocks.existingSessionDetail : null)
      );
    }),
  },
  project: {
    findFirst: vi.fn(({ where }: { where: WhereShape }) =>
      Promise.resolve(
        traced(
          "project-target-check",
          mocks.projectOrgById.get(where.id as string) === where.organizationId
            ? { id: where.id }
            : null
        )
      )
    ),
  },
  user: {
    findFirst: vi.fn(({ where }: { where: WhereShape }) =>
      Promise.resolve(
        mocks.userOrgById.get(where.id as string) === where.organizationId
          ? { id: where.id }
          : null
      )
    ),
  },
  computeTarget: {
    findFirst: vi.fn(({ where }: { where: WhereShape }) =>
      Promise.resolve(
        traced(
          "compute-target-check",
          mocks.computeTargetOrgById.get(where.id as string) ===
            where.organizationId
            ? { id: where.id }
            : null
        )
      )
    ),
  },
};

export function listRow(id: string) {
  return { id, name: `session ${id}`, status: SESSION_STATUS.ACTIVE };
}

/** Reset every fake to the default world. Each suite calls this in `beforeEach`. */
export function resetSessionWriteMocks(): void {
  vi.clearAllMocks();
  mocks.txRolledBack = false;
  mocks.callOrder = [];
  mocks.existingSessionDetail = null;
  mocks.existingStoredExternalKey = null;
  mocks.lookedUpExternalKeys = [];
  mocks.acquireSessionAdvisoryLocks.mockImplementation(() => {
    mocks.callOrder.push("advisory-lock");
    return Promise.resolve();
  });
  mocks.sessionOrgById = new Map([
    [SESSION_A, ORG_ID],
    [SESSION_B, ORG_ID],
    [FOREIGN_SESSION, OTHER_ORG_ID],
    [NON_SESSION_ARTIFACT, ORG_ID],
  ]);
  mocks.artifactTypeById = new Map([
    [SESSION_A, ArtifactType.Session],
    [SESSION_B, ArtifactType.Session],
    [FOREIGN_SESSION, ArtifactType.Session],
    [NON_SESSION_ARTIFACT, ArtifactType.Document],
  ]);
  mocks.projectOrgById = new Map([
    [PROJECT_ID, ORG_ID],
    [FOREIGN_PROJECT_ID, OTHER_ORG_ID],
  ]);
  mocks.userOrgById = new Map([
    [ACTOR_ID, ORG_ID],
    [OWNER_ID, ORG_ID],
    [FOREIGN_OWNER_ID, OTHER_ORG_ID],
  ]);
  mocks.computeTargetOrgById = new Map([
    [COMPUTE_TARGET_ID, ORG_ID],
    [FOREIGN_COMPUTE_TARGET_ID, OTHER_ORG_ID],
  ]);
  mocks.artifactUpdateMany.mockImplementation(
    ({ where }: { where: WhereShape }) =>
      Promise.resolve({
        count: matchesOrg(where, idsFromWhere(where.id), mocks.sessionOrgById),
      })
  );
  mocks.projectIdBySession = new Map([
    [SESSION_A, null],
    [SESSION_B, null],
  ]);
  mocks.ownerIdBySession = new Map([
    [SESSION_A, null],
    [SESSION_B, null],
    [FOREIGN_SESSION, null],
  ]);
  mocks.lockedArtifactRowById = new Map([
    [SESSION_A, { status: SESSION_STATUS.ACTIVE, projectId: null }],
    [SESSION_B, { status: SESSION_STATUS.ACTIVE, projectId: null }],
    [FOREIGN_SESSION, { status: SESSION_STATUS.ACTIVE, projectId: null }],
  ]);
  mocks.artifactFindMany.mockImplementation(
    ({ where }: { where: WhereShape }) =>
      Promise.resolve(
        idsFromWhere(where.id)
          .filter(
            (id) =>
              matchesOrg(where, [id], mocks.sessionOrgById) === 1 &&
              mocks.projectIdBySession.has(id)
          )
          .map((id) => ({
            id,
            projectId: mocks.projectIdBySession.get(id) ?? null,
          }))
      )
  );
  // The ISS-9465 pre-read is raw SQL, because it takes `FOR NO KEY UPDATE` and
  // Prisma's `findMany` cannot. The fake decides from the values the statement
  // BINDS — the same rule as the `where`-shaped doubles above — so dropping the
  // org or type binding from the production predicate leaves it nothing to
  // match and reds the mixed-set cases.
  mocks.queryRaw.mockImplementation((statement: FakeSql) => {
    const text = statement.strings.join("");
    // `lockSessionArtifactRow` (the ISS-9486 guard lock) is the one raw lookup
    // here that selects "status" and binds a single id rather than a
    // `Prisma.join`-wrapped list. It is keyed on the SELECT list alone, so a
    // "status" reference in another lookup's WHERE cannot route that lookup
    // here and have its joined id list read as one plain id.
    if (selectList(text).includes('"status"')) {
      const [sessionId, organizationId, type] = statement.values as [
        unknown,
        string,
        string,
      ];
      if (typeof sessionId !== "string") {
        throw new Error(
          'session-write fake: a raw lookup selecting "status" bound a non-string id; only lockSessionArtifactRow is modelled here'
        );
      }
      const authorized =
        matchesOrg(
          { organizationId, type },
          [sessionId],
          mocks.sessionOrgById
        ) === 1;
      const row = authorized
        ? mocks.lockedArtifactRowById.get(sessionId)
        : undefined;
      return Promise.resolve(
        row
          ? [
              {
                ...row,
                assigneeId: mocks.ownerIdBySession.get(sessionId) ?? null,
              },
            ]
          : []
      );
    }
    const [joined, organizationId, type] = statement.values as [
      FakeSql,
      string,
      string,
    ];
    const ids = (joined.values as FakeSql[]).map(
      (row) => row.values[0] as string
    );
    const matches = (id: string) =>
      matchesOrg({ organizationId, type }, [id], mocks.sessionOrgById) === 1;
    return Promise.resolve(
      ids
        .filter((id) => matches(id) && mocks.projectIdBySession.has(id))
        .sort()
        .map((id) => ({
          id,
          projectId: mocks.projectIdBySession.get(id) ?? null,
          assigneeId: mocks.ownerIdBySession.get(id) ?? null,
        }))
    );
  });
  mocks.artifactFindFirst.mockImplementation(
    ({ where }: { where: WhereShape }) =>
      Promise.resolve(
        matchesOrg(where, [where.id as string], mocks.sessionOrgById) === 1
          ? { id: where.id }
          : null
      )
  );
  mocks.sessionDetailCreate.mockImplementation(() =>
    Promise.resolve(traced("create", { artifactId: SESSION_A }))
  );
  mocks.generateSlug.mockResolvedValue("SES-1");
  mocks.listSessionsByArtifactIds.mockImplementation(
    (_org: string, ids: readonly string[]) => Promise.resolve(ids.map(listRow))
  );
}

const SELECT_LIST_PATTERN = /\bSELECT\b([\s\S]*?)\bFROM\b/;

/**
 * The column list between a raw statement's first SELECT and FROM. Throws on a
 * statement with no such span, so a lookup this fake does not model fails
 * loudly instead of falling through to a branch that answers for another one.
 */
function selectList(text: string): string {
  const match = SELECT_LIST_PATTERN.exec(text);
  if (!match) {
    throw new Error(
      `session-write fake: raw statement has no SELECT ... FROM list: ${text}`
    );
  }
  return match[1];
}
