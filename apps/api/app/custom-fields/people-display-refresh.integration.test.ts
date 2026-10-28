/**
 * ISS-8970: a user rename re-derives the cached PEOPLE sort key
 * (`custom_field_values.display_value`) for every row naming that user.
 *
 * Real Postgres because the contract is about what lands in the column, where
 * the GIN-served read stops, and what a compare-and-set UPDATE does under a
 * concurrent value write — none of which a mocked client can replay.
 */
import { randomUUID } from "node:crypto";
import {
  CustomFieldEntityType,
  CustomFieldType,
} from "@repo/api/src/types/custom-field";
import { DocumentStatus } from "@repo/api/src/types/document";
import {
  ArtifactSubtype,
  ArtifactType,
  type TransactionClient,
  withDb,
} from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { resolveExternalGitHubAuthorInTransaction } from "@/app/comments/external-authors";
import { usersService } from "@/app/users/service";
import {
  PEOPLE_DISPLAY_REFRESH_PAGE_SIZE,
  refreshPeopleDisplayValuesForUser,
  refreshPeopleDisplayValuesForUserWithDb,
} from "./people-display-refresh";
import { customFieldValuesService } from "./values-service";

const env = keys();
const hasDatabase = !!env.DATABASE_URL;

async function seedDocumentArtifact(organizationId: string): Promise<string> {
  const artifact = await withDb((db) =>
    db.artifact.create({
      data: {
        organizationId,
        type: ArtifactType.DOCUMENT,
        subtype: ArtifactSubtype.FEATURE,
        status: DocumentStatus.Draft,
        name: `Doc ${randomUUID()}`,
      },
      select: { id: true },
    })
  );
  return artifact.id;
}

async function seedField(
  organizationId: string,
  fieldType: CustomFieldType
): Promise<string> {
  const field = await withDb((db) =>
    db.customField.create({
      data: {
        organizationId,
        name: `Field ${randomUUID()}`,
        fieldType,
        entityTypes: [CustomFieldEntityType.Document],
      },
      select: { id: true },
    })
  );
  return field.id;
}

async function setPeople(
  fieldId: string,
  entityId: string,
  organizationId: string,
  userIds: string[]
) {
  return await customFieldValuesService.setValueForEntity(
    fieldId,
    CustomFieldEntityType.Document,
    entityId,
    organizationId,
    userIds
  );
}

function readRow(fieldId: string, entityId: string) {
  return withDb((db) =>
    db.customFieldValue.findFirstOrThrow({
      where: { customFieldId: fieldId, entityId },
      select: { id: true, displayValue: true, updatedAt: true },
    })
  );
}

function renameRaw(userId: string, lastName: string | null) {
  return withDb((db) =>
    db.user.update({ where: { id: userId }, data: { lastName } })
  );
}

function refresh(userId: string, organizationId: string) {
  return refreshPeopleDisplayValuesForUser(userId, organizationId);
}

/**
 * A client whose compare-and-set UPDATE runs `beforeStatement` first, so a test
 * can land a competing write in the window between the refresh's read and its
 * write. Only `$queryRaw` is intercepted; every read goes to the real client.
 */
function interceptCompareAndSet(
  db: TransactionClient,
  beforeStatement: () => Promise<void>
): TransactionClient {
  const queryRaw = db.$queryRaw.bind(db);
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop !== "$queryRaw") {
        return Reflect.get(target, prop, receiver);
      }
      return async (...args: Parameters<typeof queryRaw>) => {
        await beforeStatement();
        return await queryRaw(...args);
      };
    },
  });
}

describe.skipIf(!hasDatabase)(
  "refreshPeopleDisplayValuesForUser (ISS-8970)",
  () => {
    it("rewrites every row naming the user, in the row's stored id order", async () => {
      await autoRollbackTransaction(async () => {
        const organizationId = await createTestOrganization();
        const ada = await createTestUser(organizationId, {
          firstName: "Ada",
          lastName: "Lovelace",
        });
        const alan = await createTestUser(organizationId, {
          firstName: "Alan",
          lastName: "Turing",
        });
        const fieldId = await seedField(organizationId, CustomFieldType.People);
        const first = await seedDocumentArtifact(organizationId);
        const second = await seedDocumentArtifact(organizationId);
        await setPeople(fieldId, first, organizationId, [alan.id, ada.id]);
        await setPeople(fieldId, second, organizationId, [ada.id]);

        await renameRaw(ada.id, "Byron");
        const rewritten = await refresh(ada.id, organizationId);

        expect(rewritten).toBe(2);
        expect((await readRow(fieldId, first)).displayValue).toBe(
          "Alan T., Ada B."
        );
        expect((await readRow(fieldId, second)).displayValue).toBe("Ada B.");
      });
    });

    it("leaves rows that do not name the user, other-org rows, and malformed non-PEOPLE rows alone", async () => {
      await autoRollbackTransaction(async () => {
        const organizationId = await createTestOrganization();
        const otherOrganizationId = await createTestOrganization();
        const ada = await createTestUser(organizationId, {
          firstName: "Ada",
          lastName: "Lovelace",
        });
        const alan = await createTestUser(organizationId, {
          firstName: "Alan",
          lastName: "Turing",
        });
        const fieldId = await seedField(organizationId, CustomFieldType.People);
        const alanOnly = await seedDocumentArtifact(organizationId);
        await setPeople(fieldId, alanOnly, organizationId, [alan.id]);
        const alanRow = await readRow(fieldId, alanOnly);

        // A MULTI_ENUM row whose `peopleValueIds` holds the user — a shape the
        // write path never produces, so it must be a query guarantee that it is
        // not rewritten.
        const multiEnumFieldId = await seedField(
          organizationId,
          CustomFieldType.MultiEnum
        );
        const malformedEntity = await seedDocumentArtifact(organizationId);
        const malformed = await withDb((db) =>
          db.customFieldValue.create({
            data: {
              customFieldId: multiEnumFieldId,
              organizationId,
              entityType: CustomFieldEntityType.Document,
              entityId: malformedEntity,
              multiEnumValueIds: [],
              peopleValueIds: [ada.id],
              displayValue: "Some Tag",
            },
            select: { id: true },
          })
        );
        // A row in ANOTHER org naming this org's user — schema-valid, never
        // written by the service; the org predicate keeps it out.
        const foreignFieldId = await seedField(
          otherOrganizationId,
          CustomFieldType.People
        );
        const foreignEntity = await seedDocumentArtifact(otherOrganizationId);
        const foreign = await withDb((db) =>
          db.customFieldValue.create({
            data: {
              customFieldId: foreignFieldId,
              organizationId: otherOrganizationId,
              entityType: CustomFieldEntityType.Document,
              entityId: foreignEntity,
              multiEnumValueIds: [],
              peopleValueIds: [ada.id],
              displayValue: "Ada L.",
            },
            select: { id: true },
          })
        );

        await renameRaw(ada.id, "Byron");
        const rewritten = await refresh(ada.id, organizationId);

        expect(rewritten).toBe(0);
        expect(await readRow(fieldId, alanOnly)).toEqual(alanRow);
        const untouched = await withDb((db) =>
          db.customFieldValue.findMany({
            where: { id: { in: [malformed.id, foreign.id] } },
            select: { id: true, displayValue: true },
            orderBy: { displayValue: "asc" },
          })
        );
        expect(untouched).toEqual([
          { id: foreign.id, displayValue: "Ada L." },
          { id: malformed.id, displayValue: "Some Tag" },
        ]);
      });
    });

    it("writes nothing for a same-name rename or a NULL column whose recomputed key is empty", async () => {
      await autoRollbackTransaction(async () => {
        const organizationId = await createTestOrganization();
        const ada = await createTestUser(organizationId, {
          firstName: "Ada",
          lastName: "Lovelace",
        });
        const nameless = await createTestUser(organizationId, {
          firstName: null,
          lastName: null,
        });
        const fieldId = await seedField(organizationId, CustomFieldType.People);
        const adaDoc = await seedDocumentArtifact(organizationId);
        await setPeople(fieldId, adaDoc, organizationId, [ada.id]);
        const before = await readRow(fieldId, adaDoc);

        // A NULL-stored column naming only a nameless person: the recomputed
        // key is "", which is the same nothing — not a change.
        const namelessDoc = await seedDocumentArtifact(organizationId);
        await withDb((db) =>
          db.customFieldValue.create({
            data: {
              customFieldId: fieldId,
              organizationId,
              entityType: CustomFieldEntityType.Document,
              entityId: namelessDoc,
              multiEnumValueIds: [],
              peopleValueIds: [nameless.id],
              displayValue: null,
            },
          })
        );

        expect(await refresh(ada.id, organizationId)).toBe(0);
        expect(await refresh(nameless.id, organizationId)).toBe(0);
        expect(await readRow(fieldId, adaDoc)).toEqual(before);
        expect((await readRow(fieldId, namelessDoc)).displayValue).toBeNull();
      });
    });

    it("drops a person who became nameless from the key", async () => {
      await autoRollbackTransaction(async () => {
        const organizationId = await createTestOrganization();
        const ada = await createTestUser(organizationId, {
          firstName: "Ada",
          lastName: "Lovelace",
        });
        const alan = await createTestUser(organizationId, {
          firstName: "Alan",
          lastName: "Turing",
        });
        const fieldId = await seedField(organizationId, CustomFieldType.People);
        const doc = await seedDocumentArtifact(organizationId);
        await setPeople(fieldId, doc, organizationId, [ada.id, alan.id]);

        await withDb((db) =>
          db.user.update({
            where: { id: ada.id },
            data: { firstName: null, lastName: null },
          })
        );
        await refresh(ada.id, organizationId);

        expect((await readRow(fieldId, doc)).displayValue).toBe("Alan T.");
      });
    });

    it("does not clobber a row whose people changed between its read and its UPDATE (compare-and-set)", async () => {
      await autoRollbackTransaction(async () => {
        const organizationId = await createTestOrganization();
        const ada = await createTestUser(organizationId, {
          firstName: "Ada",
          lastName: "Lovelace",
        });
        const alan = await createTestUser(organizationId, {
          firstName: "Alan",
          lastName: "Turing",
        });
        const fieldId = await seedField(organizationId, CustomFieldType.People);
        const doc = await seedDocumentArtifact(organizationId);
        await setPeople(fieldId, doc, organizationId, [ada.id]);
        await renameRaw(ada.id, "Byron");

        // Interleave: the refresh's read sees [ada]; before its UPDATE lands, a
        // value write replaces the people with [alan] and caches "Alan T.".
        // The CAS predicate no longer matches, so the row keeps the writer's
        // string instead of "Ada B." derived from an array it no longer holds.
        let interleaved = false;
        const rewritten = await withDb(async (db) => {
          const findMany = db.customFieldValue.findMany.bind(
            db.customFieldValue
          );
          const proxied = new Proxy(db, {
            get(target, prop, receiver) {
              if (prop !== "customFieldValue") {
                return Reflect.get(target, prop, receiver);
              }
              return {
                ...target.customFieldValue,
                findMany: async (args: Parameters<typeof findMany>[0]) => {
                  const page = await findMany(args);
                  if (!interleaved) {
                    interleaved = true;
                    await setPeople(fieldId, doc, organizationId, [alan.id]);
                  }
                  return page;
                },
              };
            },
          });
          return await refreshPeopleDisplayValuesForUserWithDb(
            proxied,
            ada.id,
            organizationId
          );
        });

        expect(interleaved).toBe(true);
        expect(rewritten).toBe(0);
        expect((await readRow(fieldId, doc)).displayValue).toBe("Alan T.");
      });
    });

    it("does not clobber a row a NEWER refresh rewrote between its read and its UPDATE", async () => {
      await autoRollbackTransaction(async () => {
        const organizationId = await createTestOrganization();
        const ada = await createTestUser(organizationId, {
          firstName: "Ada",
          lastName: "Lovelace",
        });
        const fieldId = await seedField(organizationId, CustomFieldType.People);
        const doc = await seedDocumentArtifact(organizationId);
        await setPeople(fieldId, doc, organizationId, [ada.id]);

        // Two rename deliveries interleave: this refresh reads the row and the
        // users while the name is "Byron"; before its UPDATE lands, a later
        // rename to "King" is applied AND refreshed. The older key "Ada B."
        // must not overwrite "Ada K." — the display-string CAS refuses it, and
        // the retry re-reads a row that already holds the live key.
        let statements = 0;
        const rewritten = await withDb(async (db) => {
          const proxied = interceptCompareAndSet(db, async () => {
            statements += 1;
            if (statements === 1) {
              await renameRaw(ada.id, "King");
              await refresh(ada.id, organizationId);
            }
          });
          await renameRaw(ada.id, "Byron");
          return await refreshPeopleDisplayValuesForUserWithDb(
            proxied,
            ada.id,
            organizationId
          );
        });

        expect(statements).toBe(1);
        expect(rewritten).toBe(0);
        expect((await readRow(fieldId, doc)).displayValue).toBe("Ada K.");
      });
    });

    it("retries and lands the NEWER key when an OLDER refresh won the first compare-and-set", async () => {
      await autoRollbackTransaction(async () => {
        const organizationId = await createTestOrganization();
        const ada = await createTestUser(organizationId, {
          firstName: "Ada",
          lastName: "Lovelace",
        });
        const fieldId = await seedField(organizationId, CustomFieldType.People);
        const doc = await seedDocumentArtifact(organizationId);
        await setPeople(fieldId, doc, organizationId, [ada.id]);

        // The mirror interleaving: this refresh holds the CURRENT name "Byron"
        // and read the column as "Ada L."; an older refresh, computed from a
        // name that is no longer live, lands "Ada X." first. First-writer-wins
        // alone would strand the row on "Ada X." — the miss must be retried
        // from what is stored now, and the retry must win.
        let statements = 0;
        const rewritten = await withDb(async (db) => {
          const proxied = interceptCompareAndSet(db, async () => {
            statements += 1;
            if (statements === 1) {
              await db.customFieldValue.updateMany({
                where: { customFieldId: fieldId, entityId: doc },
                data: { displayValue: "Ada X." },
              });
            }
          });
          await renameRaw(ada.id, "Byron");
          return await refreshPeopleDisplayValuesForUserWithDb(
            proxied,
            ada.id,
            organizationId
          );
        });

        expect(statements).toBe(2);
        expect(rewritten).toBe(1);
        expect((await readRow(fieldId, doc)).displayValue).toBe("Ada B.");
      });
    });

    it("rewrites a NULL-stored column once a named person is in it", async () => {
      await autoRollbackTransaction(async () => {
        const organizationId = await createTestOrganization();
        const ada = await createTestUser(organizationId, {
          firstName: "Ada",
          lastName: "Lovelace",
        });
        const fieldId = await seedField(organizationId, CustomFieldType.People);
        const doc = await seedDocumentArtifact(organizationId);
        await withDb((db) =>
          db.customFieldValue.create({
            data: {
              customFieldId: fieldId,
              organizationId,
              entityType: CustomFieldEntityType.Document,
              entityId: doc,
              multiEnumValueIds: [],
              peopleValueIds: [ada.id],
              displayValue: null,
            },
          })
        );

        // The previous-display CAS must treat NULL as a matchable value.
        expect(await refresh(ada.id, organizationId)).toBe(1);
        expect((await readRow(fieldId, doc)).displayValue).toBe("Ada L.");
      });
    });

    it("converges across more rows than one page", async () => {
      await autoRollbackTransaction(async () => {
        const organizationId = await createTestOrganization();
        const ada = await createTestUser(organizationId, {
          firstName: "Ada",
          lastName: "Lovelace",
        });
        const fieldId = await seedField(organizationId, CustomFieldType.People);
        const rowCount = PEOPLE_DISPLAY_REFRESH_PAGE_SIZE + 1;
        await withDb(async (db) => {
          await db.artifact.createMany({
            data: Array.from({ length: rowCount }, (_, i) => ({
              id: randomUUID(),
              organizationId,
              type: ArtifactType.DOCUMENT,
              subtype: ArtifactSubtype.FEATURE,
              status: DocumentStatus.Draft,
              name: `Doc ${i}`,
            })),
          });
          const artifacts = await db.artifact.findMany({
            where: { organizationId },
            select: { id: true },
          });
          await db.customFieldValue.createMany({
            data: artifacts.map((artifact) => ({
              customFieldId: fieldId,
              organizationId,
              entityType: CustomFieldEntityType.Document,
              entityId: artifact.id,
              multiEnumValueIds: [],
              peopleValueIds: [ada.id],
              displayValue: "Ada L.",
            })),
          });
        });

        await renameRaw(ada.id, "Byron");
        const rewritten = await refresh(ada.id, organizationId);

        expect(rewritten).toBe(rowCount);
        const stale = await withDb((db) =>
          db.customFieldValue.count({
            where: { customFieldId: fieldId, displayValue: { not: "Ada B." } },
          })
        );
        expect(stale).toBe(0);
      });
    });

    it("runs through the real Clerk-facing writers with no custom-field write", async () => {
      await autoRollbackTransaction(async () => {
        const organizationId = await createTestOrganization();
        const ada = await createTestUser(organizationId, {
          firstName: "Ada",
          lastName: "Lovelace",
        });
        const fieldId = await seedField(organizationId, CustomFieldType.People);
        const doc = await seedDocumentArtifact(organizationId);
        await setPeople(fieldId, doc, organizationId, [ada.id]);

        // user.updated: cross-org updateMany, then every org row refreshed.
        const count = await usersService.updateByClerkId(
          ada.clerkId,
          { lastName: "Byron" },
          new Date("2026-01-01T00:00:00Z")
        );
        expect(count).toBe(1);
        expect((await readRow(fieldId, doc)).displayValue).toBe("Ada B.");

        // membership.created / user.created: the un-stamped upsert arm.
        await usersService.upsertByClerkIdAndOrg({
          clerkId: ada.clerkId,
          organizationId,
          email: ada.email,
          firstName: "Ada",
          lastName: "King",
          avatarUrl: null,
          phoneNumber: null,
        });
        expect((await readRow(fieldId, doc)).displayValue).toBe("Ada K.");

        // The stamped arm (user.created carries a stamp): guard passes.
        await usersService.upsertByClerkIdAndOrg(
          {
            clerkId: ada.clerkId,
            organizationId,
            email: ada.email,
            firstName: "Ada",
            lastName: "Queen",
            avatarUrl: null,
            phoneNumber: null,
          },
          new Date("2026-03-01T00:00:00Z")
        );
        expect((await readRow(fieldId, doc)).displayValue).toBe("Ada Q.");

        // A redelivery the stamp guard REFUSES (older stamp: the profile write
        // does not land, the name stays "Queen") still repairs a column that
        // lags — the refresh is unconditional and diffed, not gated on count.
        const rowId = (await readRow(fieldId, doc)).id;
        await withDb((db) =>
          db.customFieldValue.update({
            where: { id: rowId },
            data: { displayValue: "stale" },
          })
        );
        await usersService.upsertByClerkIdAndOrg(
          {
            clerkId: ada.clerkId,
            organizationId,
            email: ada.email,
            firstName: "Older",
            lastName: "Payload",
            avatarUrl: null,
            phoneNumber: null,
          },
          new Date("2025-01-01T00:00:00Z")
        );
        expect((await readRow(fieldId, doc)).displayValue).toBe("Ada Q.");
      });
    });

    // Why the GitHub shadow-user writer is NOT hooked, pinned rather than
    // asserted in prose: `upsertShadowUser` is the one name writer this module
    // deliberately skips, and the reason is that a GitHub login rename never
    // reaches it. `ExternalCommentAuthor` is unique on `providerUserId`, which
    // a rename does not change, so the second materialization matches the
    // existing row, `classifyExistingExternalAuthor` returns `reuse` for its
    // own deterministic shadow user, and the function returns before the
    // upsert's update arm. The stored name and the sort key therefore stay
    // EQUAL — which is the ISS-8970 invariant — rather than drifting apart.
    it("leaves the shadow user's name and its sort key equal when a GitHub login is renamed", async () => {
      await autoRollbackTransaction(async () => {
        const organizationId = await createTestOrganization();
        const fieldId = await seedField(organizationId, CustomFieldType.People);
        const doc = await seedDocumentArtifact(organizationId);

        const first = await withDb((db) =>
          resolveExternalGitHubAuthorInTransaction(db, {
            organizationId,
            author: githubAuthor("octocat"),
            source: GITHUB_SOURCE,
          })
        );
        expect(first.source).toBe("shadow_user");

        // An inactive shadow user is a legal PEOPLE value: `validatePeopleIds`
        // scopes the lookup by org, not by `active`.
        await setPeople(fieldId, doc, organizationId, [first.user.id]);
        expect((await readRow(fieldId, doc)).displayValue).toBe("octocat G.");

        const renamed = await withDb((db) =>
          resolveExternalGitHubAuthorInTransaction(db, {
            organizationId,
            author: githubAuthor("octocat-renamed"),
            source: GITHUB_SOURCE,
          })
        );
        expect(renamed.user.id).toBe(first.user.id);

        // The reuse branch never rewrote the name, so nothing went stale.
        const storedName = await withDb((db) =>
          db.user.findUniqueOrThrow({
            where: { id: first.user.id },
            select: { firstName: true, lastName: true },
          })
        );
        expect(storedName).toEqual({
          firstName: "octocat",
          lastName: "GitHub",
        });
        expect((await readRow(fieldId, doc)).displayValue).toBe("octocat G.");
      });
    });
  }
);

/** Same GitHub account across both materializations; only the login changes. */
function githubAuthor(login: string) {
  return {
    id: 4_242_424,
    node_id: "MDQ6VXNlcjQyNDI0MjQ=",
    login,
    avatar_url: null,
    html_url: `https://github.com/${login}`,
  };
}

const GITHUB_SOURCE = {
  sourceKind: "issue_comment",
  githubObjectId: "9001",
  repositoryId: "repo-1",
  pullNumber: 42,
} as const;
