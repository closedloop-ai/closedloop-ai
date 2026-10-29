/**
 * @file navigation-section-model.ts
 * @description Pure derivation of what the shell sidebar offers, so the ordering
 * and the omission rules are testable without rendering (ISS-8377).
 *
 * Which entries are OMITTED is the load-bearing decision here, and it mirrors
 * the rule its Settings sibling already established. `forbidden` and
 * `unavailable` are authoritative answers, so those rows are dropped. A
 * `pending` or `capability-error` row is NOT dropped: omitting it would turn a
 * read that never completed into the claim "this destination does not exist for
 * you", which is the failed-read-becomes-an-absence collapse PRD-692 forbids.
 * Those rows render as themselves and are not navigable.
 *
 * SECTION AND DESTINATION IDS ARE OPAQUE STRINGS HERE ON PURPOSE. This module
 * renders an ordered hierarchy; it does not decide which routes exist or which
 * group they belong to. A navigation manifest owns that, and passing its ids
 * straight through means there is no second id vocabulary to keep in sync — this
 * fold composes with whatever manifest the adapter supplies instead of competing
 * with it.
 */
import {
  isPresentableCount,
  NavigationCountStatus,
  type NavigationDestinationCount,
  type NavigationDestinationProjection,
  NavigationDestinationStatus,
  NavigationProjectionStatus,
  type NavigationViewModel,
} from "@repo/api/src/types/navigation-view-model";

/** One destination as the manifest describes it, before the actor is applied. */
export type NavigationDestinationInput = {
  readonly id: string;
  /** Visible label and accessible destination name. */
  readonly label: string;
  /**
   * Where the row navigates. Null for a destination the manifest describes but
   * this surface has no route for, which renders as a non-navigable row rather
   * than vanishing — the same reason an unresolved capability keeps its row.
   */
  readonly href: string | null;
  /**
   * Whether the HOST this adapter runs on offers the destination at all. The
   * adapter answers it, because only the adapter knows which host it is; the
   * view model then carries the resolved outcome rather than the input, which is
   * why no Web/Desktop axis appears in this package.
   */
  readonly offeredOnHost: boolean;
  /**
   * Cap above which the badge renders `<max>+`. Omitted renders the exact count.
   *
   * Per-destination because it is a per-destination question, not a house style:
   * a long-idle Agents count overflows and is happy to say `9+`, while for Inbox
   * "47 unread" and "9+" are different facts to the person reading it. The
   * manifest owns the destination, so the manifest owns this.
   */
  readonly badgeMax?: number;
  /**
   * What the count counts, for the badge's accessible name — "recently finished
   * sessions", "unread notifications". Supplied by the manifest because only the
   * destination's owner knows what its number MEANS; a generic name is used when
   * it is absent rather than inventing one here.
   */
  readonly countNoun?: NavigationCountNoun;
};

/**
 * One ordered group. `sections` nests, which is what lets Labs hold its own
 * Artifacts, Teams, and footer groups rather than flattening them into the top
 * level and losing the prototype's hierarchy.
 */
export type NavigationSectionInput = {
  readonly id: string;
  readonly label: string;
  readonly collapsible: boolean;
  readonly defaultOpen: boolean;
  readonly destinations?: readonly NavigationDestinationInput[];
  readonly controls?: readonly NavigationControlInput[];
  readonly sections?: readonly NavigationSectionInput[];
};

export type NavigationEntryModel = {
  readonly id: string;
  readonly label: string;
  /** Non-null only when the row both has a route and resolved as navigable. */
  readonly href: string | null;
  readonly status: NavigationDestinationStatus;
  readonly navigable: boolean;
  /**
   * The count to render, or null when nothing honest can be rendered. Null
   * covers three different facts — no count concept, a count still loading, and
   * a count that could not be read — because a sidebar badge has exactly one
   * truthful rendering for all three, which is to be absent. The distinction is
   * preserved upstream in {@link NavigationDestinationProjection} for surfaces
   * that can say more than a badge can.
   */
  readonly badgeCount: number | null;
  /** Carried through from the manifest; see {@link NavigationDestinationInput}. */
  readonly badgeMax?: number;
  /** Carried through from the manifest; see {@link NavigationDestinationInput}. */
  readonly countNoun?: NavigationCountNoun;
};

export type NavigationSectionModel = {
  readonly id: string;
  readonly label: string;
  readonly collapsible: boolean;
  readonly defaultOpen: boolean;
  readonly entries: readonly NavigationEntryModel[];
  /** Offered host controls rendered before the rows, in manifest order. */
  readonly leadingControlIds: readonly string[];
  /** Offered host controls rendered after the rows, in manifest order. */
  readonly trailingControlIds: readonly string[];
  readonly sections: readonly NavigationSectionModel[];
};

type NavigationEntryPolicy = {
  /** Whether the destination gets a row at all. */
  readonly offered: boolean;
  /** Whether that row is a link rather than inert text. */
  readonly navigable: boolean;
};

/**
 * Exhaustive by type, so adding a {@link NavigationDestinationStatus} fails
 * `tsc` here until someone decides what the sidebar does with it. A partial list
 * would instead drop the new status silently — the destination would vanish from
 * navigation with nothing red to say so, which is the same collapse the omission
 * rules above exist to prevent.
 */
const NAVIGATION_ENTRY_POLICY: Record<
  NavigationDestinationStatus,
  NavigationEntryPolicy
> = {
  [NavigationDestinationStatus.Ready]: { navigable: true, offered: true },
  [NavigationDestinationStatus.Pending]: { navigable: false, offered: true },
  [NavigationDestinationStatus.CapabilityError]: {
    navigable: false,
    offered: true,
  },
  [NavigationDestinationStatus.Unavailable]: {
    navigable: false,
    offered: false,
  },
  [NavigationDestinationStatus.Forbidden]: { navigable: false, offered: false },
};

/**
 * Precedence, highest first: host availability, then whether the projection was
 * read at all, then whether THIS destination was in it, then the destination's
 * own answer.
 *
 * Host outranks the actor axis because it does not need it — a destination this
 * build does not ship cannot become reachable by learning more about the actor.
 * The read-level statuses outrank the per-destination answer for the mirror
 * image reason: a stale or absent per-destination grant must not paper over a
 * read that failed or has not landed.
 */
export function evaluateNavigationDestinationStatus(
  destination: NavigationDestinationInput,
  viewModel: NavigationViewModel
): NavigationDestinationStatus {
  if (!destination.offeredOnHost) {
    return NavigationDestinationStatus.Unavailable;
  }
  if (viewModel.projectionStatus === NavigationProjectionStatus.Pending) {
    return NavigationDestinationStatus.Pending;
  }
  if (viewModel.projectionStatus !== NavigationProjectionStatus.Ready) {
    // `Error`, and equally a projectionStatus this build does not know from a
    // newer server. Only an explicitly READY projection may authorize a row:
    // types do not constrain JSON, so an `!== Ready` guard is what stops an
    // unrecognised read-level status falling through to the per-destination
    // answer and turning every `ready` destination into a live link.
    return NavigationDestinationStatus.CapabilityError;
  }
  const projection = ownProjection(viewModel, destination.id);
  if (projection === undefined) {
    // The read succeeded overall but said nothing about this destination. That
    // is an unreadable capability, not a denial: silently dropping the row would
    // let a projection bug read as a deliberate permission decision.
    return NavigationDestinationStatus.CapabilityError;
  }
  if (!KNOWN_DESTINATION_STATUSES.has(projection.status)) {
    // A status this build does not know, from a newer server. Types do not
    // constrain JSON, so this is reachable: degrade to unreadable rather than
    // indexing the policy table with it and throwing the whole sidebar away.
    return NavigationDestinationStatus.CapabilityError;
  }
  return projection.status;
}

/**
 * The number a badge may render, or null when none may be.
 *
 * Only a settled, presentable, non-zero count produces a number. A true zero
 * returns null because an empty badge is noise rather than information, and —
 * critically — a pending or unavailable count returns null through the SAME
 * path, so a caller cannot accidentally distinguish "nothing new" from "we do
 * not know" by rendering a `0` for one of them.
 *
 * The value is re-checked even on a ready count: a projection can arrive as
 * JSON, and types do not stop a `"5"` from reaching a badge as a measurement.
 */
export function resolveNavigationBadgeCount(
  count: NavigationDestinationCount | undefined
): number | null {
  if (count === undefined || count.status !== NavigationCountStatus.Ready) {
    return null;
  }
  if (!isPresentableCount(count.value)) {
    return null;
  }
  return count.value > 0 ? count.value : null;
}

function buildEntries(
  destinations: readonly NavigationDestinationInput[],
  viewModel: NavigationViewModel
): NavigationEntryModel[] {
  const entries: NavigationEntryModel[] = [];
  for (const destination of destinations) {
    const status = evaluateNavigationDestinationStatus(destination, viewModel);
    const policy = NAVIGATION_ENTRY_POLICY[status];
    if (!policy.offered) {
      continue;
    }
    const projection = ownProjection(viewModel, destination.id);
    // A row with no route is not navigable however well its capability
    // resolved — offering a link that goes nowhere is the dead-end this guards.
    const navigable = policy.navigable && destination.href !== null;
    entries.push({
      id: destination.id,
      label: destination.label,
      href: navigable ? destination.href : null,
      status,
      navigable,
      // A row that is not navigable has not resolved, so any count attached to
      // it describes a state we cannot vouch for. Suppressing it here keeps a
      // stale number off a row that is simultaneously admitting it does not
      // know what the destination is.
      badgeCount: navigable
        ? resolveNavigationBadgeCount(projection?.count)
        : null,
      badgeMax: destination.badgeMax,
      countNoun: destination.countNoun,
    });
  }
  return entries;
}

function buildSection(
  input: NavigationSectionInput,
  viewModel: NavigationViewModel
): NavigationSectionModel | null {
  const entries = buildEntries(input.destinations ?? [], viewModel);
  const sections: NavigationSectionModel[] = [];
  for (const nested of input.sections ?? []) {
    const built = buildSection(nested, viewModel);
    if (built !== null) {
      sections.push(built);
    }
  }
  // Controls never consult the projection: they are host affordances, not
  // destinations, so a pending or failed read leaves them exactly where they are.
  const leadingControlIds = offeredControlIds(
    input.controls,
    NavigationControlPlacement.Leading
  );
  const trailingControlIds = offeredControlIds(
    input.controls,
    NavigationControlPlacement.Trailing
  );
  const isEmpty =
    entries.length === 0 &&
    sections.length === 0 &&
    leadingControlIds.length === 0 &&
    trailingControlIds.length === 0;
  if (isEmpty) {
    return null;
  }
  return {
    id: input.id,
    label: input.label,
    collapsible: input.collapsible,
    defaultOpen: input.defaultOpen,
    entries,
    leadingControlIds,
    trailingControlIds,
    sections,
  };
}

/**
 * The ordered sidebar model for this actor.
 *
 * Section order is the manifest's, never registration or resolution order, so
 * navigation cannot reshuffle as capabilities resolve. A section left with no
 * row, no nested section, and no offered control is dropped rather than rendered
 * as an empty disclosure the user can open onto nothing.
 */
export function buildNavigationSectionModel(
  sections: readonly NavigationSectionInput[],
  viewModel: NavigationViewModel
): readonly NavigationSectionModel[] {
  const models: NavigationSectionModel[] = [];
  for (const section of sections) {
    const built = buildSection(section, viewModel);
    if (built !== null) {
      models.push(built);
    }
  }
  return models;
}

/**
 * Every status this build understands, for validating one that arrived as JSON.
 * Derived from the policy table rather than listed again, so it cannot fall out
 * of step with the set the fold actually knows how to render.
 */
const KNOWN_DESTINATION_STATUSES: ReadonlySet<string> = new Set(
  Object.keys(NAVIGATION_ENTRY_POLICY)
);

/**
 * One destination's projection, by OWN key only.
 *
 * The server builds this map with a null prototype, but that guard does not
 * survive the wire: `JSON.parse` hands back an ordinary object, so a manifest id
 * of `constructor` or `toString` would otherwise return an inherited function
 * and be read as a projection. `Object.hasOwn` is what makes the guard hold on
 * the receiving side, where it is actually needed.
 */
function ownProjection(
  viewModel: NavigationViewModel,
  destinationId: string
): NavigationDestinationProjection | undefined {
  if (!Object.hasOwn(viewModel.destinations, destinationId)) {
    return;
  }
  return viewModel.destinations[destinationId];
}

/**
 * What a badge's number counts. The object form exists because a count of one
 * reads wrong in the plural ("1 recently finished sessions"), and only the
 * destination's owner knows both spellings.
 */
export type NavigationCountNoun =
  | string
  | { readonly one: string; readonly other: string };

/** Where a host control sits relative to its section's destination rows. */
export const NavigationControlPlacement = {
  Leading: "leading",
  Trailing: "trailing",
} as const;
export type NavigationControlPlacement =
  (typeof NavigationControlPlacement)[keyof typeof NavigationControlPlacement];

/**
 * A host-rendered control inside a section — search, a teams list, the dev-mode
 * switch. It is not a destination: the actor projection says nothing about it,
 * so the only question asked of it is whether this host offers it.
 */
export type NavigationControlInput = {
  readonly id: string;
  readonly offeredOnHost: boolean;
  /** Before or after the section's rows. Absent means after. */
  readonly placement?: NavigationControlPlacement;
};

function offeredControlIds(
  controls: readonly NavigationControlInput[] | undefined,
  placement: NavigationControlPlacement
): string[] {
  const ids: string[] = [];
  for (const control of controls ?? []) {
    const controlPlacement =
      control.placement ?? NavigationControlPlacement.Trailing;
    if (control.offeredOnHost && controlPlacement === placement) {
      ids.push(control.id);
    }
  }
  return ids;
}

/**
 * The noun a count takes in its accessible name. Every surface that labels a
 * navigation count pluralizes through here, so the legacy Agents badge and the
 * v2 sidebar cannot drift on how "1 recently finished session" reads.
 */
export function navigationCountNounFor(
  count: number,
  countNoun: NavigationCountNoun
): string {
  if (typeof countNoun === "string") {
    return countNoun;
  }
  return count === 1 ? countNoun.one : countNoun.other;
}
