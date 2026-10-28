/**
 * ISS-9584 — the Sessions list parity EVIDENCE scenario: the facets the desktop
 * derives from evidence rows rather than a column.
 */
import {
  SESSION_UNKNOWN_COST_BUCKET_ID,
  SessionChangePresenceId,
  type SessionCostBucketId,
  SessionPrAssociationId,
  type SessionQuality,
} from "@repo/api/src/agent-session-filters";
import type { AutonomyTier } from "@repo/api/src/session-autonomy-tiers";
import { Priority } from "@repo/api/src/types/common";
import { ListFilterOperator } from "@repo/api/src/types/list-query-expression";
import { SessionListField } from "@repo/api/src/types/list-query-fields";
import {
  anyOf,
  conform,
  desc,
  emptiness,
  row,
  SESSION_LIST_PARITY_HEADLESS_AUTONOMY,
  SessionListParityPullRequest,
  type SessionListParityRow,
  type SessionListParityScenario,
} from "./session-list-parity-model";

const byLastActivity = [desc(SessionListField.LastActivity)];

const EVIDENCE_ROWS: readonly SessionListParityRow[] = [
  row({
    key: "e1",
    turns: 1,
    costUsd: 0.5,
    autonomy: SESSION_LIST_PARITY_HEADLESS_AUTONOMY,
    linesAdded: 5,
    pullRequest: SessionListParityPullRequest.Linked,
    priority: Priority.High,
    lastActivityAt: "2026-06-12T04:00:00.000Z",
  }),
  row({
    key: "e2",
    turns: 0,
    costUsd: null,
    autonomy: null,
    linesAdded: 0,
    pullRequest: SessionListParityPullRequest.None,
    priority: null,
    lastActivityAt: "2026-06-12T03:00:00.000Z",
  }),
  row({
    key: "e3",
    turns: 1,
    costUsd: 3,
    autonomy: null,
    linesAdded: 0,
    pullRequest: SessionListParityPullRequest.Linked,
    priority: null,
    lastActivityAt: "2026-06-12T02:00:00.000Z",
  }),
  row({
    key: "e4",
    turns: 1,
    costUsd: null,
    autonomy: SESSION_LIST_PARITY_HEADLESS_AUTONOMY,
    linesAdded: 2,
    pullRequest: SessionListParityPullRequest.None,
    priority: Priority.Low,
    lastActivityAt: "2026-06-12T01:00:00.000Z",
  }),
];

const SUBSTANTIVE = "substantive" satisfies SessionQuality;
const IDLE = "idle" satisfies SessionQuality;
const UNDER_ONE = "under_1" satisfies SessionCostBucketId;
const ONE_TO_TEN = "from_1_to_10" satisfies SessionCostBucketId;
const HIGH_AUTONOMY = "high" satisfies AutonomyTier;

/**
 * The facets whose value the desktop derives from evidence rather than a
 * column: quality from turns and tokens, cost from `token_usage`, autonomy
 * from events, changes from diff stats, pull requests from artifact links.
 * e2 is idle; the rest are substantive.
 */
export const SESSION_LIST_PARITY_EVIDENCE_SCENARIO: SessionListParityScenario =
  {
    name: "evidence facets",
    rows: EVIDENCE_ROWS,
    cases: [
      conform(
        "quality substantive",
        [anyOf(SessionListField.Quality, [SUBSTANTIVE])],
        byLastActivity,
        ["e1", "e3", "e4"]
      ),
      conform(
        "quality idle, includeEmpty false",
        [anyOf(SessionListField.Quality, [IDLE], false)],
        byLastActivity,
        ["e2"]
      ),
      conform(
        "cost bucket",
        [anyOf(SessionListField.Cost, [UNDER_ONE])],
        byLastActivity,
        ["e1"]
      ),
      conform(
        "cost bucket, includeEmpty false",
        [anyOf(SessionListField.Cost, [ONE_TO_TEN], false)],
        byLastActivity,
        ["e3"]
      ),
      conform(
        "cost isEmpty",
        [emptiness(SessionListField.Cost, ListFilterOperator.IsEmpty)],
        byLastActivity,
        ["e2", "e4"]
      ),
      conform(
        "cost bucket, includeEmpty true",
        [anyOf(SessionListField.Cost, [UNDER_ONE], true)],
        byLastActivity,
        ["e1", "e2", "e4"]
      ),
      conform(
        "autonomy tier",
        [anyOf(SessionListField.Autonomy, [HIGH_AUTONOMY])],
        byLastActivity,
        ["e1", "e4"]
      ),
      conform(
        "autonomy tier, includeEmpty false",
        [anyOf(SessionListField.Autonomy, [HIGH_AUTONOMY], false)],
        byLastActivity,
        ["e1", "e4"]
      ),
      conform(
        "autonomy isEmpty",
        [emptiness(SessionListField.Autonomy, ListFilterOperator.IsEmpty)],
        byLastActivity,
        ["e2", "e3"]
      ),
      conform(
        "autonomy tier, includeEmpty true",
        [anyOf(SessionListField.Autonomy, [HIGH_AUTONOMY], true)],
        byLastActivity,
        ["e1", "e2", "e3", "e4"]
      ),
      conform(
        "has changes",
        [
          anyOf(SessionListField.ChangePresence, [
            SessionChangePresenceId.HasChanges,
          ]),
        ],
        byLastActivity,
        ["e1", "e4"]
      ),
      conform(
        "no changes, includeEmpty false",
        [
          anyOf(
            SessionListField.ChangePresence,
            [SessionChangePresenceId.NoChanges],
            false
          ),
        ],
        byLastActivity,
        ["e2", "e3"]
      ),
      conform(
        "has pull request",
        [anyOf(SessionListField.PrAssociation, [SessionPrAssociationId.HasPr])],
        byLastActivity,
        ["e1", "e3"]
      ),
      conform(
        "no pull request, includeEmpty false",
        [
          anyOf(
            SessionListField.PrAssociation,
            [SessionPrAssociationId.NoPr],
            false
          ),
        ],
        byLastActivity,
        ["e2", "e4"]
      ),
      conform(
        "priority, includeEmpty true",
        [anyOf(SessionListField.Priority, [Priority.High], true)],
        byLastActivity,
        ["e1", "e2", "e3"]
      ),
      conform(
        "priority, includeEmpty false",
        [anyOf(SessionListField.Priority, [Priority.Low], false)],
        byLastActivity,
        ["e4"]
      ),
      conform(
        "cost bucket, unknown",
        [anyOf(SessionListField.Cost, [SESSION_UNKNOWN_COST_BUCKET_ID])],
        byLastActivity,
        ["e2", "e4"]
      ),
    ],
  };
