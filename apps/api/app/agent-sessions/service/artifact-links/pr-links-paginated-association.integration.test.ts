/**
 * ISS-9859 (review, davetho): paginated PR links on a branch with a PR-head
 * association, against real Postgres.
 *
 * The association's refs carry no `method`, so the branch-link writer reads
 * them as strong and unions them into the link. Each ordering case writes the
 * same evidence twice, once as a paginated sequence and once as one whole
 * payload, and asserts the two links agree. Whole delivery is the reference
 * because pagination is a transport detail: it may not change what a link
 * says.
 *
 * Also here: an empty strong-ref page merges without deleting anything, with
 * the Replace counterfactual beside it.
 */
import {
  ArtifactRefMethod,
  ArtifactRefRelation,
  ArtifactRefTargetKind,
  SessionPrRelationType,
} from "@repo/api/src/types/session-artifact-link";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import {
  linkedPrNumbers,
  persistSessionPrLinks,
  prRef,
  SESSION_PR_LINK_REPO,
  type SessionPrLinkFixture,
  seedSessionPrLinkFixture,
  sessionPrLinkMetadata,
} from "@/__tests__/support/agent-sessions/session-pr-links.test-harness";
import { autoRollbackTransaction } from "@/__tests__/utils/db-helpers";
import { branchAggregateFromPrRef } from "./pull-request-branch-association";
import { sessionPullRequestDetailKey } from "./pull-request-details";
import { SessionPrLinkWriteMode } from "./session-pr-link-merge";

const describeIfDb = keys().DATABASE_URL ? describe : describe.skip;

describeIfDb(
  "ISS-9859: paginated PR links with a branch association (real Postgres)",
  () => {
    it("prose twin on page 0, strong ref on a later page: the link matches whole delivery", () => {
      // Page 0's twin met the association in the Replace arm, where the writer's
      // union promoted the twin's REFERENCED to strong evidence that no later
      // page could withhold. Whole delivery never has the twin.
      return autoRollbackTransaction(async () => {
        const paged = await seedFixture("iss9859-assoc-prose-first", 2);
        await persistSessionPrLinks(
          paged,
          [proseTwin(2)],
          SessionPrLinkWriteMode.Replace
        );
        await persistSessionPrLinks(
          paged,
          [prRef(2, SessionPrRelationType.Created)],
          SessionPrLinkWriteMode.Merge
        );

        const whole = await seedFixture("iss9859-assoc-prose-first-whole", 2);
        await persistSessionPrLinks(whole, [
          prRef(2, SessionPrRelationType.Created),
        ]);

        const pagedLink = await identityFields(paged);
        expect(pagedLink).toEqual(await identityFields(whole));
        expect(pagedLink.relationTypes).toEqual([
          SessionPrRelationType.Created,
        ]);
      });
    });

    it("strong ref on page 0, prose twin on a later page: the link matches whole delivery", () => {
      // The order the review described. The association is built from the
      // provider-verifiable PR artifact ref, never from a prose one, so it carries
      // the same relation on every page and the paged link agrees with the whole
      // one here with or without the association fold.
      return autoRollbackTransaction(async () => {
        const paged = await seedFixture("iss9859-assoc-strong-first", 1);
        await persistSessionPrLinks(
          paged,
          [prRef(1, SessionPrRelationType.Created)],
          SessionPrLinkWriteMode.Replace
        );
        await persistSessionPrLinks(
          paged,
          [proseTwin(1)],
          SessionPrLinkWriteMode.Merge
        );

        const whole = await seedFixture("iss9859-assoc-strong-first-whole", 1);
        await persistSessionPrLinks(whole, [
          prRef(1, SessionPrRelationType.Created),
        ]);

        const pagedLink = await identityFields(paged);
        expect(pagedLink).toEqual(await identityFields(whole));
        expect(pagedLink.relationTypes).toEqual([
          SessionPrRelationType.Created,
        ]);
      });
    });

    it("an empty strong-ref page deletes no link", () => {
      return autoRollbackTransaction(async () => {
        const fixture = await seedSessionPrLinkFixture("iss9859-empty-page", {
          1: "branch-1",
          2: "branch-1",
          3: "branch-2",
        });
        await persistSessionPrLinks(
          fixture,
          [prRef(1), prRef(2), prRef(3)],
          SessionPrLinkWriteMode.Replace
        );

        await persistSessionPrLinks(fixture, [], SessionPrLinkWriteMode.Merge);

        expect(await linkedPrNumbers(fixture)).toEqual([1, 2, 3]);
      });
    });

    it("COUNTERFACTUAL: the same empty page under Replace retracts every link", () => {
      // Proves the case above can fail: the rows it keeps are rows Replace
      // deletes.
      return autoRollbackTransaction(async () => {
        const fixture = await seedSessionPrLinkFixture(
          "iss9859-empty-replace",
          {
            1: "branch-1",
            2: "branch-1",
            3: "branch-2",
          }
        );
        await persistSessionPrLinks(
          fixture,
          [prRef(1), prRef(2), prRef(3)],
          SessionPrLinkWriteMode.Replace
        );

        await persistSessionPrLinks(
          fixture,
          [],
          SessionPrLinkWriteMode.Replace
        );

        expect(await linkedPrNumbers(fixture)).toEqual([]);
      });
    });
  }
);

/** One branch-1 PR whose detail carries a PR-head association, as production resolves it. */
async function seedFixture(
  label: string,
  prNumber: number
): Promise<SessionPrLinkFixture> {
  const fixture = await seedSessionPrLinkFixture(label, {
    [prNumber]: "branch-1",
  });
  const key = sessionPullRequestDetailKey(SESSION_PR_LINK_REPO, prNumber);
  const detail = fixture.detailMap.get(key);
  if (!detail) {
    throw new Error(`fixture has no detail for PR ${prNumber}`);
  }
  const detailMap = new Map(fixture.detailMap);
  detailMap.set(key, {
    ...detail,
    branchAssociation: branchAggregateFromPrRef(
      {
        kind: ArtifactRefTargetKind.PullRequest,
        repositoryFullName: SESSION_PR_LINK_REPO,
        prNumber,
        branchName: `feat/pr-${prNumber}`,
        method: ArtifactRefMethod.PrCreateOutput,
        relation: ArtifactRefRelation.Created,
        observedAt: "2026-05-20T17:01:00.000Z",
      },
      SESSION_PR_LINK_REPO
    ),
  });
  return { ...fixture, detailMap };
}

/** What `withProseDerivedPrRefs` mints for a PR mentioned in prose. */
function proseTwin(prNumber: number) {
  return {
    ...prRef(prNumber, SessionPrRelationType.Referenced),
    method: ArtifactRefMethod.PrMentionInProse,
  };
}

async function identityFields(fixture: SessionPrLinkFixture) {
  const metadata = await sessionPrLinkMetadata(fixture, "branch-1");
  return {
    linkKind: metadata.linkKind,
    relationTypes: metadata.relationTypes,
    prRefs: metadata.prRefs,
  };
}
