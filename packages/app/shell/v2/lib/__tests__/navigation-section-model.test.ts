import {
  NavigationActorStanding,
  NavigationCountStatus,
  NavigationDestinationStatus,
  NavigationProjectionStatus,
  type NavigationViewModel,
  PENDING_NAVIGATION_VIEW_MODEL,
  toNavigationCount,
} from "@repo/api/src/types/navigation-view-model";
import { describe, expect, it } from "vitest";
import {
  buildNavigationSectionModel,
  evaluateNavigationDestinationStatus,
  NavigationControlPlacement,
  type NavigationDestinationInput,
  type NavigationSectionInput,
  resolveNavigationBadgeCount,
} from "../navigation-section-model";

function destination(
  id: string,
  overrides: Partial<NavigationDestinationInput> = {}
): NavigationDestinationInput {
  return {
    id,
    label: id,
    href: `/${id}`,
    offeredOnHost: true,
    ...overrides,
  };
}

function viewModel(
  overrides: Partial<NavigationViewModel> = {}
): NavigationViewModel {
  return {
    projectionStatus: NavigationProjectionStatus.Ready,
    standing: NavigationActorStanding.Member,
    organizationId: "org_1",
    destinations: {},
    ...overrides,
  };
}

describe("evaluateNavigationDestinationStatus", () => {
  it("reports a host that does not offer the destination as unavailable, ahead of every actor answer", () => {
    // Host outranks the actor axis: a destination this build does not ship
    // cannot become reachable by learning more about the actor, so even a ready
    // projection must not promote it.
    expect(
      evaluateNavigationDestinationStatus(
        destination("packs", { offeredOnHost: false }),
        viewModel({
          destinations: {
            packs: { status: NavigationDestinationStatus.Ready },
          },
        })
      )
    ).toBe(NavigationDestinationStatus.Unavailable);
  });

  it("reports an in-flight projection as pending rather than as a denial", () => {
    expect(
      evaluateNavigationDestinationStatus(
        destination("sessions"),
        viewModel({ projectionStatus: NavigationProjectionStatus.Pending })
      )
    ).toBe(NavigationDestinationStatus.Pending);
  });

  it("reports a failed projection as a capability error rather than as a denial", () => {
    expect(
      evaluateNavigationDestinationStatus(
        destination("sessions"),
        viewModel({ projectionStatus: NavigationProjectionStatus.Error })
      )
    ).toBe(NavigationDestinationStatus.CapabilityError);
  });

  it("degrades a projectionStatus this build does not know rather than treating it as ready", () => {
    // The mirror of the per-destination guard below: types do not constrain
    // JSON, so a newer server sending a fourth read-level status reaches this
    // fold. Falling through the Pending and Error checks would treat it as
    // Ready and promote every destination whose own status says `ready` into a
    // live link, on a read this build cannot vouch for.
    const fromNewerServer = JSON.parse(
      '{"projectionStatus":"partial","standing":"member","organizationId":"org_1","destinations":{"sessions":{"status":"ready"}}}'
    );

    expect(
      evaluateNavigationDestinationStatus(
        destination("sessions"),
        fromNewerServer
      )
    ).toBe(NavigationDestinationStatus.CapabilityError);
  });

  it("treats a destination the projection never mentioned as unreadable, not forbidden", () => {
    // An omission is not an authorization answer. Reading it as forbidden would
    // let a projection bug present as a deliberate permission decision.
    expect(
      evaluateNavigationDestinationStatus(destination("issues"), viewModel())
    ).toBe(NavigationDestinationStatus.CapabilityError);
  });

  it("degrades a status this build does not know rather than crashing on it", () => {
    // Types do not constrain JSON: a newer server adding a sixth status reaches
    // this fold at runtime. Indexing the policy table with it would throw and
    // take the whole sidebar down, which is a worse failure than a row that
    // admits it does not know.
    const fromNewerServer = JSON.parse(
      '{"projectionStatus":"ready","standing":"member","organizationId":"org_1","destinations":{"sessions":{"status":"quarantined"}}}'
    );

    expect(
      evaluateNavigationDestinationStatus(
        destination("sessions"),
        fromNewerServer
      )
    ).toBe(NavigationDestinationStatus.CapabilityError);
  });

  it("does not read an inherited property as a destination projection", () => {
    // The server builds its map with a null prototype, but `JSON.parse` on the
    // client hands back an ordinary object — so a manifest id of `constructor`
    // would otherwise resolve to an inherited function and be read as a
    // projection whose `status` is undefined.
    const parsed = JSON.parse(
      '{"projectionStatus":"ready","standing":"member","organizationId":"org_1","destinations":{}}'
    );

    expect(
      evaluateNavigationDestinationStatus(destination("constructor"), parsed)
    ).toBe(NavigationDestinationStatus.CapabilityError);
    expect(
      evaluateNavigationDestinationStatus(destination("toString"), parsed)
    ).toBe(NavigationDestinationStatus.CapabilityError);
  });

  it("does not let a stale per-destination grant outrank a failed read", () => {
    expect(
      evaluateNavigationDestinationStatus(
        destination("sessions"),
        viewModel({
          projectionStatus: NavigationProjectionStatus.Error,
          destinations: {
            sessions: { status: NavigationDestinationStatus.Ready },
          },
        })
      )
    ).toBe(NavigationDestinationStatus.CapabilityError);
  });
});

describe("resolveNavigationBadgeCount", () => {
  it("renders only a settled, non-zero count", () => {
    expect(resolveNavigationBadgeCount(toNavigationCount(4))).toBe(4);
  });

  it("renders nothing for a true zero, a pending read, and a failed read alike", () => {
    // All three are null so a caller cannot tell them apart by rendering a `0`
    // for one of them. The distinction survives upstream in the projection.
    expect(resolveNavigationBadgeCount(toNavigationCount(0))).toBeNull();
    expect(
      resolveNavigationBadgeCount({ status: NavigationCountStatus.Pending })
    ).toBeNull();
    expect(
      resolveNavigationBadgeCount({ status: NavigationCountStatus.Unavailable })
    ).toBeNull();
    expect(resolveNavigationBadgeCount(undefined)).toBeNull();
  });

  it("never turns an impossible number into a badge", () => {
    expect(resolveNavigationBadgeCount(toNavigationCount(-3))).toBeNull();
    expect(resolveNavigationBadgeCount(toNavigationCount(2.5))).toBeNull();
  });

  it("does not render a ready count from the wire whose value is not a presentable number", () => {
    const fromWire = JSON.parse('{"status":"ready","value":"5"}');

    expect(resolveNavigationBadgeCount(fromWire)).toBeNull();
  });
});

describe("buildNavigationSectionModel", () => {
  const hierarchy: readonly NavigationSectionInput[] = [
    {
      id: "primary",
      label: "Primary",
      collapsible: false,
      defaultOpen: true,
      destinations: [destination("dashboard")],
    },
    {
      id: "artifacts",
      label: "Artifacts",
      collapsible: true,
      defaultOpen: true,
      destinations: [destination("sessions"), destination("branches")],
    },
    {
      id: "labs",
      label: "Labs",
      collapsible: true,
      defaultOpen: false,
      destinations: [destination("inbox")],
      sections: [
        {
          id: "labs-artifacts",
          label: "Artifacts",
          collapsible: true,
          defaultOpen: true,
          destinations: [destination("documents")],
        },
      ],
    },
  ];

  const allReady = viewModel({
    destinations: {
      dashboard: { status: NavigationDestinationStatus.Ready },
      sessions: {
        status: NavigationDestinationStatus.Ready,
        count: toNavigationCount(3),
      },
      branches: { status: NavigationDestinationStatus.Ready },
      inbox: { status: NavigationDestinationStatus.Ready },
      documents: { status: NavigationDestinationStatus.Ready },
    },
  });

  it("preserves the manifest's order and the Labs nesting", () => {
    const model = buildNavigationSectionModel(hierarchy, allReady);

    expect(model.map((section) => section.id)).toEqual([
      "primary",
      "artifacts",
      "labs",
    ]);
    expect(model[1].entries.map((entry) => entry.id)).toEqual([
      "sessions",
      "branches",
    ]);
    // Labs keeps its own nested group rather than flattening its members up.
    expect(model[2].sections.map((section) => section.id)).toEqual([
      "labs-artifacts",
    ]);
    expect(model[2].defaultOpen).toBe(false);
  });

  it("drops a forbidden destination and keeps an unresolved one", () => {
    const model = buildNavigationSectionModel(
      hierarchy,
      viewModel({
        destinations: {
          dashboard: { status: NavigationDestinationStatus.Ready },
          sessions: { status: NavigationDestinationStatus.Forbidden },
          branches: { status: NavigationDestinationStatus.CapabilityError },
          inbox: { status: NavigationDestinationStatus.Ready },
          documents: { status: NavigationDestinationStatus.Ready },
        },
      })
    );

    const artifacts = model.find((section) => section.id === "artifacts");
    // Forbidden is an authoritative answer, so the row goes. Capability-error is
    // not, so the row stays and says so — dropping it would turn a failed read
    // into "this destination does not exist for you".
    expect(artifacts?.entries.map((entry) => entry.id)).toEqual(["branches"]);
    expect(artifacts?.entries[0].navigable).toBe(false);
    expect(artifacts?.entries[0].href).toBeNull();
  });

  it("keeps every destination offered but non-navigable while the projection is in flight", () => {
    const model = buildNavigationSectionModel(
      hierarchy,
      viewModel({ projectionStatus: NavigationProjectionStatus.Pending })
    );

    const ids = model.flatMap((section) => [
      ...section.entries.map((entry) => entry.id),
      ...section.sections.flatMap((nested) =>
        nested.entries.map((entry) => entry.id)
      ),
    ]);
    expect(ids).toEqual([
      "dashboard",
      "sessions",
      "branches",
      "inbox",
      "documents",
    ]);
    for (const section of model) {
      for (const entry of section.entries) {
        expect(entry.navigable).toBe(false);
        expect(entry.badgeCount).toBeNull();
      }
    }
  });

  it("suppresses a count on a row that has not resolved", () => {
    const model = buildNavigationSectionModel(
      hierarchy,
      viewModel({
        projectionStatus: NavigationProjectionStatus.Ready,
        destinations: {
          sessions: {
            status: NavigationDestinationStatus.CapabilityError,
            count: toNavigationCount(3),
          },
        },
      })
    );

    const sessions = model
      .find((section) => section.id === "artifacts")
      ?.entries.find((entry) => entry.id === "sessions");
    // A row admitting it does not know what the destination is must not also
    // present a confident number about it.
    expect(sessions?.badgeCount).toBeNull();
  });

  it("renders a count on a resolved row", () => {
    const model = buildNavigationSectionModel(hierarchy, allReady);
    const sessions = model
      .find((section) => section.id === "artifacts")
      ?.entries.find((entry) => entry.id === "sessions");

    expect(sessions?.badgeCount).toBe(3);
  });

  it("drops a section whose destinations are all hidden, including its nested groups", () => {
    const model = buildNavigationSectionModel(
      hierarchy,
      viewModel({
        destinations: {
          dashboard: { status: NavigationDestinationStatus.Ready },
          sessions: { status: NavigationDestinationStatus.Forbidden },
          branches: { status: NavigationDestinationStatus.Forbidden },
          inbox: { status: NavigationDestinationStatus.Forbidden },
          documents: { status: NavigationDestinationStatus.Forbidden },
        },
      })
    );

    expect(model.map((section) => section.id)).toEqual(["primary"]);
  });

  it("grants and counts nothing under the shipped pending default", () => {
    // The default a surface renders before any read is attempted, and the one it
    // falls back to when a projection cannot be built. Pinned here because a
    // consumer that ignores an error still must not be able to render an
    // authorization or a measurement it never received.
    const model = buildNavigationSectionModel(
      hierarchy,
      PENDING_NAVIGATION_VIEW_MODEL
    );

    expect(PENDING_NAVIGATION_VIEW_MODEL.standing).toBe(
      NavigationActorStanding.Unknown
    );
    for (const section of model) {
      for (const entry of section.entries) {
        expect(entry.navigable).toBe(false);
        expect(entry.badgeCount).toBeNull();
      }
    }
    // Every destination still keeps a row, so a pending read is visibly pending
    // rather than an empty sidebar.
    expect(model.map((section) => section.id)).toEqual([
      "primary",
      "artifacts",
      "labs",
    ]);
  });

  it("does not offer a link for a destination the surface has no route for", () => {
    const model = buildNavigationSectionModel(
      [
        {
          id: "primary",
          label: "Primary",
          collapsible: false,
          defaultOpen: true,
          destinations: [destination("compute", { href: null })],
        },
      ],
      viewModel({
        destinations: {
          compute: { status: NavigationDestinationStatus.Ready },
        },
      })
    );

    expect(model[0].entries[0].navigable).toBe(false);
    expect(model[0].entries[0].href).toBeNull();
  });
});

describe("buildNavigationSectionModel — host controls", () => {
  const labsWithControls: NavigationSectionInput = {
    id: "labs",
    label: "Labs",
    collapsible: true,
    defaultOpen: false,
    destinations: [destination("inbox")],
    controls: [
      {
        id: "search",
        offeredOnHost: true,
        placement: NavigationControlPlacement.Leading,
      },
      {
        id: "compute",
        offeredOnHost: true,
        placement: NavigationControlPlacement.Trailing,
      },
      {
        id: "teams",
        offeredOnHost: false,
        placement: NavigationControlPlacement.Trailing,
      },
    ],
  };

  it("places offered controls before or after the rows and drops the ones the host does not offer", () => {
    const [labs] = buildNavigationSectionModel(
      [labsWithControls],
      viewModel({
        destinations: { inbox: { status: NavigationDestinationStatus.Ready } },
      })
    );

    expect(labs.leadingControlIds).toEqual(["search"]);
    expect(labs.trailingControlIds).toEqual(["compute"]);
  });

  it("keeps a section whose only content is an offered control, placed after the rows by default", () => {
    const model = buildNavigationSectionModel(
      [
        {
          id: "labs-teams",
          label: "Teams",
          collapsible: false,
          defaultOpen: true,
          controls: [{ id: "teams", offeredOnHost: true }],
        },
        {
          id: "labs-footer",
          label: "Footer",
          collapsible: false,
          defaultOpen: true,
          controls: [{ id: "compute", offeredOnHost: false }],
        },
      ],
      viewModel()
    );

    expect(model.map((section) => section.id)).toEqual(["labs-teams"]);
    expect(model[0].leadingControlIds).toEqual([]);
    expect(model[0].trailingControlIds).toEqual(["teams"]);
  });

  it.each([
    [NavigationProjectionStatus.Pending, NavigationDestinationStatus.Pending],
    [
      NavigationProjectionStatus.Error,
      NavigationDestinationStatus.CapabilityError,
    ],
  ])(
    "keeps controls in place under a %s projection while its rows stop being links",
    (projectionStatus, rowStatus) => {
      const [labs] = buildNavigationSectionModel(
        [labsWithControls],
        viewModel({ projectionStatus })
      );

      expect(labs.leadingControlIds).toEqual(["search"]);
      expect(labs.trailingControlIds).toEqual(["compute"]);
      expect(
        labs.entries.map((entry) => [entry.id, entry.status, entry.navigable])
      ).toEqual([["inbox", rowStatus, false]]);
    }
  );
});
