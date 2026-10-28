/**
 * ISS-9584 — the Sessions list parity KNOWN DIVERGENCE scenarios: where the
 * two hosts answer the same query differently today. Each side asserts its
 * current answer; `SESSION_LIST_KNOWN_DIVERGENCE_OWNER` names who settles it.
 */
import {
  type SessionCostBucketId,
  SessionPrAssociationId,
} from "@repo/api/src/agent-session-filters";
import { ListQueryRefusal } from "@repo/api/src/types/list-query-expression";
import { SessionListField } from "@repo/api/src/types/list-query-fields";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { Harness } from "../../harness/types";
import {
  anyOf,
  asc,
  between,
  conform,
  desc,
  divergence,
  refusal,
  row,
  SessionListKnownDivergence,
  SessionListParityOwner,
  SessionListParityPullRequest,
  type SessionListParityRow,
  type SessionListParityScenario,
} from "./session-list-parity-model";

const A = SessionListParityOwner.A;
const B = SessionListParityOwner.B;
const byLastActivity = [desc(SessionListField.LastActivity)];
const ONE_TO_TEN = "from_1_to_10" satisfies SessionCostBucketId;

/**
 * Two sessions equal on every key either host orders by. Seeded in array
 * order; the cloud mints `artifactId` as a UUIDv7, so the second row gets the
 * larger id, while the keys sort the other way. The cloud runner checks the
 * two orders differ before asserting, so the row cannot pass by an accident of
 * alignment.
 */
const TIE_ROWS: readonly SessionListParityRow[] = [
  row({ key: "tie-b", repositoryFullName: "org/tie", costUsd: 3 }),
  row({ key: "tie-a", repositoryFullName: "org/tie", costUsd: 3 }),
];
const TIE_KEYS = TIE_ROWS.map((tied) => tied.key);
const TIE_BY_ID_DESC = ["tie-b", "tie-a"];

const TIE_SCENARIO: SessionListParityScenario = {
  name: "tie",
  rows: TIE_ROWS,
  cases: [
    // The desktop SQL cursor tier. Before ISS-9584 it broke an ascending tie
    // `id ASC`; FEA-4329 closes it DESC on both hosts.
    divergence(
      "tie, last activity asc",
      SessionListKnownDivergence.TieOrderByHostIdentity,
      [],
      [asc(SessionListField.LastActivity)],
      { byHostIdentityDesc: TIE_KEYS },
      TIE_BY_ID_DESC
    ),
    // The desktop repository-scoped id read, the second site ISS-9584 moves.
    divergence(
      "tie, one repository, last activity asc",
      SessionListKnownDivergence.TieOrderByHostIdentity,
      [anyOf(SessionListField.Repo, ["org/tie"])],
      [asc(SessionListField.LastActivity)],
      { byHostIdentityDesc: TIE_KEYS },
      TIE_BY_ID_DESC
    ),
  ],
};

/**
 * Two sessions tied on every sort key, with the later `updatedAt` on the row
 * whose id sorts lower. The desktop hydrated tier keeps cursor order on a tie,
 * `updated_at DESC, id DESC`, so it answers by recency where the SQL tiers
 * (`TIE_SCENARIO`) answer by id. The cloud closes the tie by `artifactId`
 * descending, and the second row seeded gets the larger one.
 */
const RECENCY_TIE_ROWS: readonly SessionListParityRow[] = [
  row({ key: "recent-a", updatedAt: "2026-06-12T09:00:00.000Z" }),
  row({ key: "recent-b" }),
];
const RECENCY_TIE_KEYS = RECENCY_TIE_ROWS.map((tied) => tied.key);
const RECENCY_TIE_BY_CURSOR = ["recent-a", "recent-b"];

const RECENCY_TIE_SCENARIO: SessionListParityScenario = {
  name: "hydrated tie by cursor order",
  rows: RECENCY_TIE_ROWS,
  cases: [
    divergence(
      "hydrated tie, cost asc",
      SessionListKnownDivergence.HydratedTieByCursorOrder,
      [],
      [asc(SessionListField.Cost)],
      { byHostIdentityDesc: RECENCY_TIE_KEYS },
      RECENCY_TIE_BY_CURSOR
    ),
    // A harness filter sends this read to the hydrated tier. Without it the
    // same sort takes the SQL cursor tier, which closes the tie by id.
    divergence(
      "hydrated tie, one harness, last activity asc",
      SessionListKnownDivergence.HydratedTieByCursorOrder,
      [anyOf(SessionListField.Harness, [Harness.Claude])],
      [asc(SessionListField.LastActivity)],
      { byHostIdentityDesc: RECENCY_TIE_KEYS },
      RECENCY_TIE_BY_CURSOR
    ),
  ],
};

const NULL_ROWS: readonly SessionListParityRow[] = [
  row({
    key: "n1",
    model: "amber",
    costUsd: 1,
    lastActivityAt: "2026-06-12T08:00:00.000Z",
  }),
  row({
    key: "n2",
    model: null,
    costUsd: null,
    lastActivityAt: "2026-06-12T09:00:00.000Z",
  }),
  row({
    key: "n3",
    model: "birch",
    costUsd: 3,
    lastActivityAt: "2026-06-12T10:00:00.000Z",
  }),
];

/**
 * Both hosts keep a row with no model, or no measured cost, LAST in both
 * directions: the cloud's NULLS LAST, which the desktop matches since ISS-9479.
 */
const NULL_SCENARIO: SessionListParityScenario = {
  name: "null ordering",
  rows: NULL_ROWS,
  cases: [
    conform(
      "null model, model asc",
      [],
      [asc(SessionListField.Model)],
      ["n1", "n3", "n2"]
    ),
    conform(
      "null cost, cost asc",
      [],
      [asc(SessionListField.Cost)],
      ["n1", "n3", "n2"]
    ),
    conform(
      "null model, model desc",
      [],
      [desc(SessionListField.Model)],
      ["n3", "n1", "n2"]
    ),
  ],
};

const OWNER_ROWS: readonly SessionListParityRow[] = [
  row({ key: "o1", owner: A, lastActivityAt: "2026-06-12T08:00:00.000Z" }),
  row({ key: "o2", owner: B, lastActivityAt: "2026-06-12T09:00:00.000Z" }),
];

const OWNER_SCENARIO: SessionListParityScenario = {
  name: "owner collation",
  rows: OWNER_ROWS,
  cases: [
    // Cloud compares lowercased display names by code unit ("zed adams" first);
    // the desktop by the ISS-9585 collation ("émile brun" first).
    divergence(
      "owner asc",
      SessionListKnownDivergence.OwnerCollation,
      [],
      [asc(SessionListField.User)],
      { keys: ["o1", "o2"] },
      ["o2", "o1"]
    ),
    // ISS-12251: the cloud's own name for the Owner sort, ordered exactly as
    // `user`; the desktop sorts its local Owner only as `user` (D-7).
    refusal(
      "assignee asc",
      [],
      [asc(SessionListField.Assignee)],
      ["o1", "o2"],
      ListQueryRefusal.UnsupportedField
    ),
  ],
};

/**
 * Mixed case, where a code-unit compare ("Beta" < "alpha") and a locale
 * compare ("alpha" < "Beta") disagree. A single-rule model sort runs in
 * Postgres on the cloud and the ISS-9585 collation on the desktop; both order
 * by locale, so this conforms.
 */
const MIXED_CASE_ROWS: readonly SessionListParityRow[] = [
  row({ key: "c1", model: "Beta", lastActivityAt: "2026-06-12T08:00:00.000Z" }),
  row({
    key: "c2",
    model: "alpha",
    lastActivityAt: "2026-06-12T09:00:00.000Z",
  }),
];

const MIXED_CASE_SCENARIO: SessionListParityScenario = {
  name: "mixed-case model",
  rows: MIXED_CASE_ROWS,
  cases: [
    conform(
      "model asc, mixed case",
      [],
      [asc(SessionListField.Model)],
      ["c2", "c1"]
    ),
  ],
};

const DATE_ROWS: readonly SessionListParityRow[] = [
  row({
    key: "d1",
    startedAt: "2026-06-15T02:00:00.000Z",
    lastActivityAt: "2026-06-15T03:00:00.000Z",
  }),
  row({
    key: "d2",
    startedAt: "2026-06-15T08:00:00.000Z",
    lastActivityAt: "2026-06-15T09:00:00.000Z",
  }),
];

const DATE_SCENARIO: SessionListParityScenario = {
  name: "date time zone",
  rows: DATE_ROWS,
  cases: [
    // An offsetless bound names a UTC instant on both hosts (ISS-9585), so
    // the window is 00:00Z-23:59Z and holds both rows. Read in the process's
    // zone instead, America/Chicago (UTC-5 in June) would start it at 05:00Z
    // and drop d1, which is why the desktop runs this row in that zone.
    {
      ...conform(
        "offsetless window",
        [
          between(
            SessionListField.LastActivity,
            "2026-06-15T00:00:00",
            "2026-06-15T23:59:59"
          ),
        ],
        byLastActivity,
        ["d2", "d1"]
      ),
      timeZones: { cloud: "UTC", desktop: "America/Chicago" },
    },
  ],
};

/**
 * `r1` is stored `active` but has an end instant and no activity after it.
 * ISS-11239 (owner ruling, 2026-09-26) makes both hosts filter on the stored
 * status, so it is an Active row to the Status filter whatever end it carries.
 */
const STATUS_ROWS: readonly SessionListParityRow[] = [
  row({
    key: "r1",
    status: SESSION_STATUS.ACTIVE,
    lastActivityAt: "2026-06-12T08:00:00.000Z",
    endedAt: "2026-06-12T08:00:00.000Z",
  }),
  row({
    key: "r2",
    status: SESSION_STATUS.ACTIVE,
    lastActivityAt: "2026-06-12T09:00:00.000Z",
    endedAt: null,
  }),
  row({
    key: "r3",
    status: SESSION_STATUS.INACTIVE,
    lastActivityAt: "2026-06-12T10:00:00.000Z",
  }),
];

const STATUS_SCENARIO: SessionListParityScenario = {
  name: "ended active row status filtering",
  rows: STATUS_ROWS,
  cases: [
    conform(
      "ended active row, status active",
      [anyOf(SessionListField.Status, [SESSION_STATUS.ACTIVE])],
      byLastActivity,
      ["r2", "r1"]
    ),
    conform(
      "ended active row, status inactive",
      [anyOf(SessionListField.Status, [SESSION_STATUS.INACTIVE])],
      byLastActivity,
      ["r3"]
    ),
  ],
};

const EVIDENCE_DIVERGENCE_ROWS: readonly SessionListParityRow[] = [
  // Desktop folds a null model to "unknown" (ISS-9476 DESKTOP_MODEL); the
  // cloud matches the literal only.
  row({ key: "m1", model: null, lastActivityAt: "2026-06-12T08:00:00.000Z" }),
  // An authored PR with no branch write.
  row({
    key: "m2",
    pullRequest: SessionListParityPullRequest.AuthoredWithoutBranch,
    lastActivityAt: "2026-06-12T09:00:00.000Z",
  }),
  // A cost only the session total carries.
  row({
    key: "m3",
    turns: 1,
    costUsd: null,
    sessionTotalCostUsd: 4,
    lastActivityAt: "2026-06-12T10:00:00.000Z",
  }),
];

const EVIDENCE_DIVERGENCE_SCENARIO: SessionListParityScenario = {
  name: "evidence divergences",
  rows: EVIDENCE_DIVERGENCE_ROWS,
  cases: [
    divergence(
      "unknown model",
      SessionListKnownDivergence.ModelUnknownFold,
      [anyOf(SessionListField.Model, ["unknown"])],
      byLastActivity,
      { keys: [] },
      ["m1"]
    ),
    divergence(
      "authored PR without a branch",
      SessionListKnownDivergence.PullRequestWithoutBranch,
      [anyOf(SessionListField.PrAssociation, [SessionPrAssociationId.HasPr])],
      byLastActivity,
      { keys: ["m2"] },
      []
    ),
    divergence(
      "cost on the session total only",
      SessionListKnownDivergence.CostSource,
      [anyOf(SessionListField.Cost, [ONE_TO_TEN])],
      byLastActivity,
      { keys: ["m3"] },
      []
    ),
  ],
};

/** Every divergence scenario, each seeded into its own store on each host. */
export const SESSION_LIST_PARITY_DIVERGENCE_SCENARIOS: readonly SessionListParityScenario[] =
  [
    TIE_SCENARIO,
    RECENCY_TIE_SCENARIO,
    NULL_SCENARIO,
    OWNER_SCENARIO,
    MIXED_CASE_SCENARIO,
    DATE_SCENARIO,
    STATUS_SCENARIO,
    EVIDENCE_DIVERGENCE_SCENARIO,
  ];
