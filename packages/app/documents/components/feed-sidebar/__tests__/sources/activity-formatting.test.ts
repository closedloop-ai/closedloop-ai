/**
 * The activity adapter (ISS-12117): one test per ISS-10994 catalog row, both
 * status shapes, the bulk suffix, the unknown-field fallback, every actor kind,
 * and the ISS-5007 rules (no uuid, no serialized JSON, own-property lookups).
 *
 * The rows are the story fixtures themselves (`activity-catalog.fixtures.ts`),
 * so a fixture that drifts from its wording fails here, not only in a story.
 */

import { ArtifactActivityAction } from "@repo/api/src/types/artifact-activity";
import {
  ActivityFeedActorKind,
  ActivityFeedItemSource,
  type ArtifactActivityFeedItem,
} from "@repo/api/src/types/artifact-activity-feed";
import { DocumentType } from "@repo/api/src/types/document";
import type { User } from "@repo/api/src/types/user";
import {
  ACTIVITY_CATALOG,
  type ActivityCatalogId,
  ATLAS,
  C02_ACTOR_VARIANTS,
  DEPARTED_USER_ID,
  EMILY,
  FRONTEND_TAG,
  JAKE,
  MISSING_USER_ROW,
  ORION,
  RYAN,
} from "@repo/app/documents/components/artifact-activity/activity-catalog.fixtures";
import {
  type ActivityTimelineRow,
  ActivityTimelineRowKind,
} from "@repo/app/documents/components/artifact-activity/activity-timeline";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ActivityActorBadge,
  type ActivityLookups,
  ActivityPartKind,
  activityPartsToText,
  describeActivity,
  describeActivityParts,
} from "../../sources/activity-formatting";
import { formatSnapshotValue } from "../../sources/activity-snapshot";
import {
  ActivityArtifactKind,
  type ActivityDirectory,
  ActivityDirectoryStatus,
} from "../../sources/activity-types";

function ready<T extends { id: string }>(records: T[]): ActivityDirectory<T> {
  return {
    status: ActivityDirectoryStatus.Ready,
    find: (id) => records.find((record) => record.id === id) ?? null,
  };
}

const PENDING: ActivityDirectory<never> = {
  status: ActivityDirectoryStatus.Pending,
  find: () => null,
};
const UNAVAILABLE: ActivityDirectory<never> = {
  status: ActivityDirectoryStatus.Unavailable,
  find: () => null,
};

const USERS = ready<User>([EMILY, JAKE, RYAN]);
const PROJECTS = ready([ATLAS, ORION]);
const TAGS = ready([FRONTEND_TAG]);

const RELATED: ActivityLookups["relatedArtifact"] = (id) =>
  id === "00000000-0000-7000-8000-000000000150"
    ? { key: "PRD-751", title: "Activity timeline requirements", href: "#prd" }
    : null;

function eventOf(row: ActivityTimelineRow): ArtifactActivityFeedItem {
  if (row.kind !== ActivityTimelineRowKind.Activity) {
    throw new Error("expected an activity row");
  }
  return row.item.event;
}

/** The lookups a fully wired host gives a catalog row of this kind. */
function lookupsFor(id: ActivityCatalogId): ActivityLookups {
  const entry = ACTIVITY_CATALOG[id];
  return {
    users: USERS,
    projects: PROJECTS,
    tags: TAGS,
    relatedArtifact: RELATED,
    versionHref: (version) => `#v${version}`,
    reportHref: () => "#report",
    artifactKind: entry.artifactKind,
    documentType: entry.documentType,
  };
}

function catalogText(id: ActivityCatalogId): string {
  return describeActivity(eventOf(ACTIVITY_CATALOG[id].row), lookupsFor(id));
}

function makeEvent(
  overrides: Partial<ArtifactActivityFeedItem>
): ArtifactActivityFeedItem {
  return {
    id: "event:1",
    source: ActivityFeedItemSource.Event,
    action: null,
    actor: { kind: ActivityFeedActorKind.Human, id: EMILY.id },
    before: null,
    after: null,
    payload: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("describeActivity: every ISS-10994 catalog row", () => {
  it.each<[ActivityCatalogId, string]>([
    ["C01", "created this issue Draft"],
    ["C02", "changed status from Draft to In Review"],
    ["C03", "changed status from Todo to In Progress · bulk update"],
    ["C04", "changed status from Blocked to Todo · automatically"],
    ["C05", "changed status from Active to Inactive"],
    // R4: the reaper and ingest store identical rows; no cause is stated.
    ["C06", "changed status from Active to Inactive"],
    ["C07", "changed status from Active to Failed"],
    ["C08", "assigned Jake Morrison"],
    ["C09", "changed approver from Emily Carter to Ryan Brooks"],
    ["C10", "changed owner from Emily Carter to Jake Morrison"],
    ["C11", "set owner to Jake Morrison · bulk update"],
    ["C12", "changed the title Old title → Revised title"],
    ["C13", "set due date to Oct 12, 2026"],
    ["C14", "changed priority from Low to High"],
    ["C15", "changed priority from Low to High · bulk update"],
    ["C16", "changed priority from Medium to High"],
    ["C17", "changed priority from Medium to High"],
    ["C18", "set priority Medium · from desktop sync"],
    ["C19", "moved this from Atlas to Orion"],
    ["C20", "moved this from Atlas to Orion · bulk move"],
    ["C21", "moved this session from Atlas to Orion"],
    ["C22", "moved this session to Orion · from desktop sync"],
    ["C23", "renamed this session Old name → New name"],
    ["C24", "named this session Refactor auth middleware · from desktop sync"],
    ["C25", "added the frontend tag · bulk update"],
    ["C26", "added the frontend tag"],
    ["C27", "removed the frontend tag"],
    ["C28", "added the frontend tag"],
    ["C29", "removed the frontend tag"],
    [
      "C30",
      "recorded activity on branch feature/auth-refactor · not linked yet",
    ],
    ["C31", "recorded activity on PR #123 · not linked yet"],
    ["P1", "edited the document · v2"],
    ["P2", "produced PRD-751 Activity timeline requirements"],
    ["P4", "added a Plan evaluation report"],
  ])("%s reads “%s”", (id, expected) => {
    expect(catalogText(id)).toBe(expected);
  });

  it("covers every catalog id", () => {
    expect(Object.keys(ACTIVITY_CATALOG)).toHaveLength(34);
  });
});

describe("describeActivityParts: the parts each look draws", () => {
  it("draws statuses as pills in the status registry's tones", () => {
    const { parts } = describeActivityParts(
      eventOf(ACTIVITY_CATALOG.C02.row),
      lookupsFor("C02")
    );
    const pills = parts.flatMap((part) =>
      part.kind === ActivityPartKind.Status ? [part] : []
    );
    expect(pills.map((pill) => pill.raw)).toEqual(["DRAFT", "IN_REVIEW"]);
    for (const pill of pills) {
      expect(pill.tone).toEqual(expect.any(String));
    }
  });

  it("draws a tag in its own colour", () => {
    const { parts } = describeActivityParts(
      eventOf(ACTIVITY_CATALOG.C26.row),
      lookupsFor("C26")
    );
    expect(parts).toContainEqual({
      kind: ActivityPartKind.Tag,
      id: FRONTEND_TAG.id,
      name: "frontend",
      color: FRONTEND_TAG.color,
    });
  });

  it("draws a rename as the old value, then the new one", () => {
    const { parts } = describeActivityParts(
      eventOf(ACTIVITY_CATALOG.C12.row),
      lookupsFor("C12")
    );
    expect(parts).toContainEqual({
      kind: ActivityPartKind.Rename,
      before: "Old title",
      after: "Revised title",
    });
  });

  it("links the version, the related artifact and the report", () => {
    const hrefOf = (id: ActivityCatalogId) =>
      describeActivityParts(eventOf(ACTIVITY_CATALOG[id].row), lookupsFor(id))
        .href;
    expect(hrefOf("P1")).toBe("#v2");
    expect(hrefOf("P2")).toBe("#prd");
    expect(hrefOf("P4")).toBe("#report");
  });

  it("draws a branch name as code", () => {
    const { parts } = describeActivityParts(
      eventOf(ACTIVITY_CATALOG.C30.row),
      lookupsFor("C30")
    );
    expect(parts).toContainEqual({
      kind: ActivityPartKind.Code,
      text: "feature/auth-refactor",
    });
  });
});

describe("describeActivity: both status shapes", () => {
  it("reads the bare-string shape an API key or older client stores", () => {
    expect(
      describeActivity(
        makeEvent({
          action: ArtifactActivityAction.StatusChange,
          before: "DRAFT",
          after: "IN_REVIEW",
        })
      )
    ).toBe("changed status from Draft to In Review");
  });

  it("reads the provenance envelope a named surface stores", () => {
    expect(
      describeActivity(
        makeEvent({
          action: ArtifactActivityAction.StatusChange,
          before: { field: "status", value: "DRAFT" },
          after: {
            field: "status",
            value: "IN_REVIEW",
            surface: "detail",
            result: "committed",
          },
        })
      )
    ).toBe("changed status from Draft to In Review");
  });

  it("adds the bulk suffix when the envelope's surface is bulk", () => {
    expect(
      describeActivity(
        makeEvent({
          action: ArtifactActivityAction.StatusChange,
          before: { field: "status", value: "DRAFT" },
          after: {
            field: "status",
            value: "IN_REVIEW",
            surface: "bulk",
            result: "committed",
            commitGroupId: "00000000-0000-7000-8000-000000000140",
          },
        })
      )
    ).toBe("changed status from Draft to In Review · bulk update");
  });

  it("words a Session's statuses in the Session vocabulary", () => {
    expect(
      describeActivity(
        makeEvent({
          action: ArtifactActivityAction.StatusChange,
          before: "inactive",
          after: "active",
        }),
        { artifactKind: ActivityArtifactKind.Session }
      )
    ).toBe("changed status from Inactive to Active");
  });

  it("uses the universal status words when that flag is on", () => {
    expect(
      describeActivity(
        makeEvent({
          action: ArtifactActivityAction.StatusChange,
          before: "TODO",
          after: "IN_PROGRESS",
        }),
        { universalStatus: true, documentType: DocumentType.Feature }
      )
    ).toBe("changed status from Todo to In progress");
  });

  it("shows a status this build does not know as stored", () => {
    expect(
      describeActivity(
        makeEvent({
          action: ArtifactActivityAction.StatusChange,
          before: "active",
          after: "paused_by_future_client",
        }),
        { artifactKind: ActivityArtifactKind.Session }
      )
    ).toBe("changed status from Active to paused_by_future_client");
  });
});

describe("describeActivity: unknown actions and fields", () => {
  it("reads an unknown field as “updated {field}” and reports it once", () => {
    const onUnknown = vi.fn();
    const event = makeEvent({
      action: ArtifactActivityAction.FieldChange,
      before: { field: "storyPoints", value: 3 },
      after: { field: "storyPoints", value: 5 },
    });

    expect(() => describeActivity(event, { onUnknown })).not.toThrow();
    expect(describeActivity(event, { onUnknown })).toBe("updated story points");
    expect(onUnknown).toHaveBeenCalledTimes(1);
    expect(onUnknown).toHaveBeenCalledWith("field:storyPoints");
  });

  it("reads an unknown action as a generic change without throwing", () => {
    expect(
      describeActivity(
        makeEvent({ action: "archived_by_future_client" as never })
      )
    ).toBe("made a change");
  });

  it("reads an unknown projection source generically", () => {
    expect(
      describeActivity(makeEvent({ source: "future_source" as never }))
    ).toBe("updated this artifact");
  });
});

describe("describeActivityParts: actors", () => {
  it("names a person with no badge", () => {
    const description = describeActivityParts(
      eventOf(C02_ACTOR_VARIANTS.human),
      { users: USERS }
    );
    expect(description.actor.name).toBe("Emily Carter");
    expect(description.badge).toBeUndefined();
  });

  it("resolves an agent row to the API-key owner, with the API badge", () => {
    const description = describeActivityParts(
      eventOf(C02_ACTOR_VARIANTS.agent),
      { users: USERS }
    );
    expect(description.actor.kind).toBe(ActivityFeedActorKind.Agent);
    expect(description.actor.user?.id).toBe(EMILY.id);
    expect(description.actor.name).toBe("Emily Carter");
    expect(description.badge).toBe(ActivityActorBadge.Api);
  });

  it("never resolves the system to a person, and gives it no badge", () => {
    const description = describeActivityParts(
      eventOf(C02_ACTOR_VARIANTS.system),
      { users: USERS }
    );
    expect(description.actor.name).toBe("System");
    expect(description.actor.user).toBeNull();
    expect(description.badge).toBeUndefined();
  });

  it("says a person is unknown only once the directory has settled", () => {
    const description = describeActivityParts(eventOf(MISSING_USER_ROW), {
      users: USERS,
    });
    expect(description.actor.name).toBe("Unknown user");
    const text = activityPartsToText(description.parts);
    expect(text).toBe("assigned Unknown user");
    expect(text).not.toContain(DEPARTED_USER_ID);
  });

  it("holds every name while the directory is pending", () => {
    const description = describeActivityParts(eventOf(MISSING_USER_ROW), {
      users: PENDING,
    });
    expect(description.actor.pending).toBe(true);
    expect(description.parts).toContainEqual({
      kind: ActivityPartKind.Pending,
      id: DEPARTED_USER_ID,
    });
  });

  it("claims nothing about a person when the directory is unavailable", () => {
    const description = describeActivityParts(eventOf(MISSING_USER_ROW), {
      users: UNAVAILABLE,
    });
    expect(description.actor.name).toBe("Member");
    expect(activityPartsToText(description.parts)).toBe("updated the assignee");
  });
});

describe("describeActivity: degrading without a lookup", () => {
  it("says a tag was added, not which, when tags cannot be read", () => {
    expect(
      describeActivity(eventOf(ACTIVITY_CATALOG.C26.row), {
        tags: UNAVAILABLE,
      })
    ).toBe("added a tag");
  });

  it("says the project changed, never the project id", () => {
    const text = describeActivity(eventOf(ACTIVITY_CATALOG.C19.row));
    expect(text).toBe("updated the project");
    expect(text).not.toContain(ATLAS.id);
  });

  it("says which way a derivation went when the artifact cannot be named", () => {
    expect(describeActivity(eventOf(ACTIVITY_CATALOG.P2.row))).toBe(
      "produced a related artifact"
    );
  });

  it("names the document kind it created", () => {
    const event = eventOf(ACTIVITY_CATALOG.C01.row);
    expect(describeActivity(event, { documentType: DocumentType.Prd })).toBe(
      "created this PRD Draft"
    );
    expect(
      describeActivity(event, {
        documentType: DocumentType.ImplementationPlan,
      })
    ).toBe("created this plan Draft");
  });
});

describe("describeActivity: C08, C09, C13 and C14 variants", () => {
  const users = { users: USERS };

  it.each([
    [null, JAKE.id, "assigned Jake Morrison"],
    [JAKE.id, null, "unassigned Jake Morrison"],
    [EMILY.id, JAKE.id, "reassigned from Emily Carter to Jake Morrison"],
  ])("assignee %s → %s reads “%s”", (before, after, expected) => {
    expect(
      describeActivity(
        makeEvent({
          action: ArtifactActivityAction.Assignment,
          before: { field: "assigneeId", value: before },
          after: { field: "assigneeId", value: after },
        }),
        users
      )
    ).toBe(expected);
  });

  it("sets an approver", () => {
    expect(
      describeActivity(
        makeEvent({
          action: ArtifactActivityAction.Assignment,
          before: { field: "approverId", value: null },
          after: { field: "approverId", value: RYAN.id },
        }),
        users
      )
    ).toBe("set Ryan Brooks as approver");
  });

  it.each([
    [null, "2026-10-12T00:00:00.000Z", "set due date to Oct 12, 2026"],
    [
      "2026-10-12T00:00:00.000Z",
      "2026-10-19T00:00:00.000Z",
      "changed due date from Oct 12, 2026 to Oct 19, 2026",
    ],
    ["2026-10-12T00:00:00.000Z", null, "removed the due date"],
  ])("due date %s → %s reads “%s”", (before, after, expected) => {
    expect(
      describeActivity(
        makeEvent({
          action: ArtifactActivityAction.FieldChange,
          before: { field: "dueDate", value: before },
          after: { field: "dueDate", value: after },
        })
      )
    ).toBe(expected);
  });

  it.each([
    [null, "HIGH", "set priority High"],
    ["HIGH", null, "cleared priority"],
  ])("priority %s → %s reads “%s”", (before, after, expected) => {
    expect(
      describeActivity(
        makeEvent({
          action: ArtifactActivityAction.FieldChange,
          before: { field: "priority", value: before },
          after: { field: "priority", value: after },
        })
      )
    ).toBe(expected);
  });

  // The web client revives `dueDate` into a real Date before the feed sees it.
  it("reads a due date that arrived as a revived Date, as its UTC day", () => {
    expect(
      describeActivity(
        makeEvent({
          action: ArtifactActivityAction.FieldChange,
          before: { field: "dueDate", value: null },
          after: {
            field: "dueDate",
            value: new Date("2026-02-01T00:00:00.000Z"),
          } as never,
        })
      )
    ).toBe("set due date to Feb 1, 2026");
  });

  it("renders the same calendar day west of UTC", () => {
    const previous = Reflect.get(process.env, "TZ");
    process.env.TZ = "America/Los_Angeles";
    try {
      expect(
        describeActivity(
          makeEvent({
            action: ArtifactActivityAction.FieldChange,
            before: null,
            after: { field: "dueDate", value: "2026-02-01T00:00:00.000Z" },
          })
        )
      ).toBe("set due date to Feb 1, 2026");
    } finally {
      if (previous === undefined) {
        Reflect.deleteProperty(process.env, "TZ");
      } else {
        process.env.TZ = previous;
      }
    }
  });
});

describe("formatSnapshotValue (ISS-5007)", () => {
  it("returns null for null / empty string", () => {
    expect(formatSnapshotValue(null)).toBeNull();
    expect(formatSnapshotValue("")).toBeNull();
  });

  it("stringifies scalars, including false and zero", () => {
    expect(formatSnapshotValue("TODO")).toBe("TODO");
    expect(formatSnapshotValue(false)).toBe("false");
    expect(formatSnapshotValue(0)).toBe("0");
  });

  it("returns null for an unparseable Date instead of 'Invalid Date'", () => {
    expect(formatSnapshotValue(new Date("not-a-real-date"))).toBeNull();
  });

  it("unwraps both snapshot shapes to the scalar", () => {
    expect(formatSnapshotValue({ status: "IN_REVIEW" })).toBe("IN_REVIEW");
    expect(formatSnapshotValue({ field: "priority", value: "MEDIUM" })).toBe(
      "MEDIUM"
    );
  });

  // This join is what put `field: priority, value: MEDIUM` and a whole
  // serialized artifact snapshot on screen as user-facing copy.
  it("never joins an unresolvable object into a key: value dump", () => {
    expect(formatSnapshotValue({ a: "x", b: 2 })).toBeNull();
    expect(
      formatSnapshotValue({ title: "Enhance Signals", status: "TODO", id: "x" })
    ).toBeNull();
  });
});

describe("describeActivity: no serialization reaches the copy (ISS-5007)", () => {
  it("never prints a creation snapshot's title or keys", () => {
    const text = describeActivity(
      makeEvent({
        action: ArtifactActivityAction.Creation,
        after: { status: "TODO", title: "Enhance Session Quality Signals" },
      })
    );
    expect(text).not.toContain("Enhance");
    expect(text).not.toContain("status:");
  });

  it("never prints field/value tokens or an id for any catalog row", () => {
    for (const id of Object.keys(ACTIVITY_CATALOG) as ActivityCatalogId[]) {
      const text = catalogText(id);
      expect(text).not.toContain("field:");
      expect(text).not.toContain("value:");
      expect(text).not.toContain("00000000-0000-7000");
    }
  });
});

describe("describeActivity: inherited-key safety", () => {
  // Field keys and values are persisted data, so a prototype key is reachable
  // input. A bare map lookup returns Object.prototype (or a function), which
  // reaches React as a non-element child and takes the whole feed down.
  it.each([
    ["__proto__", "updated proto"],
    ["constructor", "updated constructor"],
    ["toString", "updated to string"],
  ])("labels the inherited field key %s as text", (field, expected) => {
    expect(
      describeActivity(
        makeEvent({
          action: ArtifactActivityAction.FieldChange,
          after: { field, value: "x" },
        })
      )
    ).toBe(expected);
  });

  it.each(["__proto__", "constructor", "toString"])(
    "keeps the inherited status value %s as a string",
    (value) => {
      expect(
        describeActivity(
          makeEvent({
            action: ArtifactActivityAction.StatusChange,
            before: "DRAFT",
            after: value,
          })
        )
      ).toBe(`changed status from Draft to ${value}`);
    }
  );
});

describe("describeActivityParts: review follow-ups (ISS-12117)", () => {
  it.each<[string, ArtifactActivityFeedItem["actor"], ActivityLookups]>([
    [
      "no owner id",
      { kind: ActivityFeedActorKind.Agent, id: null },
      { users: USERS },
    ],
    [
      "an owner not in the directory",
      { kind: ActivityFeedActorKind.Agent, id: DEPARTED_USER_ID },
      { users: USERS },
    ],
    [
      "an unavailable directory",
      { kind: ActivityFeedActorKind.Agent, id: EMILY.id },
      { users: UNAVAILABLE },
    ],
  ])("gives an unresolved agent (%s) no API badge", (_case, actor, lookups) => {
    const description = describeActivityParts(
      makeEvent({
        actor,
        action: ArtifactActivityAction.StatusChange,
        before: "DRAFT",
        after: "IN_REVIEW",
      }),
      lookups
    );
    expect(description.actor.name).toBe("Agent");
    expect(description.badge).toBeUndefined();
  });

  it("holds the tag's place while the tag directory is pending", () => {
    const { parts } = describeActivityParts(eventOf(ACTIVITY_CATALOG.C26.row), {
      tags: PENDING,
    });
    expect(parts).toContainEqual({
      kind: ActivityPartKind.Pending,
      id: FRONTEND_TAG.id,
    });
    expect(activityPartsToText(parts)).toBe("added the … tag");
  });

  it("says “created this document” when the host gives no subtype", () => {
    expect(describeActivity(eventOf(ACTIVITY_CATALOG.C01.row))).toBe(
      "created this document Draft"
    );
  });

  // ISS-5007 edge cases: each degrades to a phrase with no value, never a
  // uuid, JSON or an epoch.
  it.each<[string, Partial<ArtifactActivityFeedItem>, string]>([
    [
      "an array of objects as a title",
      {
        action: ArtifactActivityAction.FieldChange,
        before: { field: "title", value: [{ a: 1 }] as never },
        after: { field: "title", value: [{ b: 2 }] as never },
      },
      "changed the title",
    ],
    [
      "an array of ids as a title",
      {
        action: ArtifactActivityAction.FieldChange,
        before: null,
        after: { field: "title", value: [EMILY.id, JAKE.id] },
      },
      "changed the title",
    ],
    [
      "an object due date",
      {
        action: ArtifactActivityAction.FieldChange,
        before: { field: "dueDate", value: null },
        after: { field: "dueDate", value: { a: 1, b: 2 } },
      },
      "changed the due date",
    ],
    [
      "an invalid Date due date",
      {
        action: ArtifactActivityAction.FieldChange,
        before: { field: "dueDate", value: null },
        after: { field: "dueDate", value: new Date("nope") } as never,
      },
      "changed the due date",
    ],
    [
      "a numeric (epoch) due date",
      {
        action: ArtifactActivityAction.FieldChange,
        before: { field: "dueDate", value: null },
        after: { field: "dueDate", value: 1_791_201_600_000 },
      },
      "changed the due date",
    ],
    [
      "an unparseable due date string",
      {
        action: ArtifactActivityAction.FieldChange,
        before: { field: "dueDate", value: null },
        after: { field: "dueDate", value: "not-a-date" },
      },
      "changed the due date",
    ],
    [
      "a status stored as an id",
      {
        action: ArtifactActivityAction.StatusChange,
        before: "DRAFT",
        after: EMILY.id,
      },
      "changed the status",
    ],
    [
      "a priority stored as an id",
      {
        action: ArtifactActivityAction.FieldChange,
        before: { field: "priority", value: "LOW" },
        after: { field: "priority", value: EMILY.id },
      },
      "updated the priority",
    ],
  ])("degrades %s to “%s”", (_case, overrides, expected) => {
    const text = describeActivity(makeEvent(overrides));
    expect(text).toBe(expected);
    expect(text).not.toContain("00000000-0000-7000");
    expect(text).not.toContain("[object Object]");
    expect(text).not.toContain("1791201600000");
  });
});

it("renders hierarchy receipts with the existing human-readable field fallback, never their inverse JSON", () => {
  const base = eventOf(ACTIVITY_CATALOG.C02.row);
  const description = describeActivityParts(
    {
      ...base,
      action: ArtifactActivityAction.FieldChange,
      before: {
        field: "projectHierarchy",
        value: { artifactId: "private-id", links: [] },
      },
      after: {
        field: "projectHierarchy",
        value: {
          artifactId: "private-id",
          links: [{ metadata: "private-metadata" }],
        },
        source: "drag",
        descendantCount: 3,
      },
    },
    {}
  );
  expect(activityPartsToText(description.parts)).toBe(
    "updated project hierarchy"
  );
});
