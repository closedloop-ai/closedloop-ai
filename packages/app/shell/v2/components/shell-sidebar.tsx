"use client";

import { NavigationDestinationStatus } from "@repo/api/src/types/navigation-view-model";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarNavLinkItem,
} from "@repo/design-system/components/ui/sidebar";
import { SidebarCollapsibleSection } from "@repo/design-system/components/ui/sidebar-collapsible-section";
import { SidebarCountBadge } from "@repo/design-system/components/ui/sidebar-count-badge";
import { Fragment, type ReactNode } from "react";
import { isActiveDestination } from "../lib/active-destination";
import {
  type NavigationCountNoun,
  type NavigationEntryModel,
  type NavigationSectionModel,
  navigationCountNounFor,
} from "../lib/navigation-section-model";

/**
 * The word a row shows when it is offered but not navigable.
 *
 * Exhaustive by type so a new {@link NavigationDestinationStatus} fails `tsc`
 * here until someone decides what the row SAYS. The word is rendered as visible
 * text and is part of the row's accessible name, never a colour or an opacity
 * change alone (WCAG 1.4.1) — a greyed row and a loading row look identical to
 * anyone who cannot compare two shades, and mean very different things.
 *
 * `Unavailable` and `Forbidden` map to null because the model never offers a row
 * in those states; they are listed so the exhaustiveness is real rather than a
 * partial map that happens to compile.
 */
export const ENTRY_STATE_WORD = {
  [NavigationDestinationStatus.Ready]: null,
  [NavigationDestinationStatus.Pending]: "Loading",
  [NavigationDestinationStatus.CapabilityError]: "Unavailable",
  [NavigationDestinationStatus.Unavailable]: null,
  [NavigationDestinationStatus.Forbidden]: null,
} as const satisfies Record<NavigationDestinationStatus, string | null>;

export type ShellSidebarProps = {
  /**
   * The ordered hierarchy, already resolved against the actor. The composite
   * renders what it is given and decides nothing about membership or order —
   * that belongs to the manifest and the fold, so Web and Desktop handed the
   * same model cannot render different navigation.
   */
  readonly sections: readonly NavigationSectionModel[];
  /** Current location, used only to mark the active row. */
  readonly activePath?: string | null;
  /**
   * Workspace header content. A slot rather than an implementation: the
   * workspace menu's CONTENTS belong to a different owner, and the shell only
   * mounts them.
   */
  readonly workspaceHeader?: ReactNode;
  /** Footer slot, for onboarding content this composite does not own. */
  readonly footer?: ReactNode;
  /**
   * Rendered first inside the sidebar root, above the workspace header, for host
   * chrome that has to sit in the sidebar column (a window drag strip).
   */
  readonly leading?: ReactNode;
  /**
   * Renders one host control (search, a teams list, the dev-mode switch) where the
   * model places it. The model owns the position; the host owns the node.
   */
  readonly renderControl?: (controlId: string) => ReactNode;
  /** Per-destination icon, supplied by the surface adapter from the manifest. */
  readonly renderIcon?: (destinationId: string) => ReactNode;
  /** Prefix for the localStorage keys that persist each section's open state. */
  readonly sectionPersistenceKeyPrefix?: string;
};

// Deliberately NOT offering an `inert` prop. `Sidebar` spreads unknown props
// onto a real element only on desktop widths; below the `md:` breakpoint it
// renders a Radix `Sheet`, which drops them. An `inert` that silently stops
// working on mobile is a guarantee the caller would rely on and not get, so the
// prop is absent until the design system can honor it on both branches.

/**
 * The shared shell sidebar (ISS-8356).
 *
 * One composite renders the hierarchy for both surfaces so Desktop and Web
 * cannot drift: everything that differs between them — routing, host support,
 * icons, persistence namespace — arrives as data or as a slot, and neither
 * surface forks the tree.
 *
 * The composite does NOT read the program rollout key. Which shell exists at all
 * is chosen once at the root and published downward as data; a read here could
 * disagree with that choice and produce a half-legacy screen.
 */
export function ShellSidebar({
  activePath = null,
  footer,
  leading,
  renderControl,
  renderIcon,
  sectionPersistenceKeyPrefix,
  sections,
  workspaceHeader,
}: ShellSidebarProps) {
  return (
    <Sidebar variant="inset">
      {leading}
      {workspaceHeader ? (
        <SidebarHeader className="pb-0">
          <SidebarMenu>
            <SidebarMenuItem>{workspaceHeader}</SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
      ) : null}

      <SidebarContent className="gap-1 pt-2">
        {sections.map((section) => (
          <ShellSidebarSection
            activePath={activePath}
            key={section.id}
            persistenceKeyPrefix={sectionPersistenceKeyPrefix}
            renderControl={renderControl}
            renderIcon={renderIcon}
            section={section}
          />
        ))}
      </SidebarContent>

      {footer ? (
        <SidebarFooter className="gap-2">{footer}</SidebarFooter>
      ) : null}
    </Sidebar>
  );
}

function ShellSidebarSection({
  activePath,
  nested = false,
  persistenceKeyPrefix,
  renderControl,
  renderIcon,
  section,
}: {
  activePath: string | null;
  /**
   * True for a group inside another group. Only a nested group overrides the
   * section's default padding; a top-level one keeps `p-1` so its rows line up
   * with the ungrouped primary rows above them. The recursion cannot infer its
   * own depth, so it is passed.
   */
  nested?: boolean;
  persistenceKeyPrefix?: string;
  renderControl?: (controlId: string) => ReactNode;
  renderIcon?: (destinationId: string) => ReactNode;
  section: NavigationSectionModel;
}) {
  const body = (
    <>
      <ShellSidebarControls
        controlIds={section.leadingControlIds}
        renderControl={renderControl}
      />
      {section.entries.length > 0 ? (
        <SidebarMenu className="gap-0">
          {section.entries.map((entry) => (
            <ShellSidebarRow
              activePath={activePath}
              entry={entry}
              key={entry.id}
              renderIcon={renderIcon}
            />
          ))}
        </SidebarMenu>
      ) : null}
      <ShellSidebarControls
        controlIds={section.trailingControlIds}
        renderControl={renderControl}
      />
      {section.sections.map((child) => (
        <ShellSidebarSection
          activePath={activePath}
          key={child.id}
          nested
          persistenceKeyPrefix={persistenceKeyPrefix}
          renderControl={renderControl}
          renderIcon={renderIcon}
          section={child}
        />
      ))}
    </>
  );

  if (!section.collapsible) {
    // A nested headless group (Labs › Teams, Labs › Footer) is a run of content
    // inside its parent, not a second inset group: wrapping it again would push
    // its controls in past every sibling row.
    return nested ? body : <SidebarGroup className="p-1">{body}</SidebarGroup>;
  }

  return (
    <SidebarCollapsibleSection
      className={nested ? "px-0 py-1" : undefined}
      defaultOpen={section.defaultOpen}
      persistenceKey={
        persistenceKeyPrefix
          ? `${persistenceKeyPrefix}.${section.id}`
          : undefined
      }
      title={section.label}
    >
      {body}
    </SidebarCollapsibleSection>
  );
}

function ShellSidebarRow({
  activePath,
  entry,
  renderIcon,
}: {
  activePath: string | null;
  entry: NavigationEntryModel;
  renderIcon?: (destinationId: string) => ReactNode;
}) {
  const icon = renderIcon?.(entry.id) ?? null;
  const stateWord = ENTRY_STATE_WORD[entry.status];
  const isActive = isActiveDestination(activePath, entry.href);

  if (entry.navigable && entry.href !== null) {
    return (
      <SidebarNavLinkItem
        className="text-sm"
        href={entry.href}
        icon={icon}
        isActive={isActive}
        title={entry.label}
        tooltip={entry.label}
        // The row the user is standing on carries no badge. A navigation count
        // says what is NEW since the last visit, and arriving is what drains it,
        // so a number on the open route is stale in the frame it renders. Stated
        // HERE, beside the active answer it needs, rather than in each adapter:
        // every count a host layers on — whatever its source, on either shell —
        // passes through this row, which is what makes the legacy badge's own
        // rule (`agents-nav-badge.tsx`) and the v2 tree agree by construction.
        trailing={
          isActive || entry.badgeCount === null ? undefined : (
            <SidebarCountBadge
              count={entry.badgeCount}
              label={badgeLabel(entry.badgeCount, entry.countNoun, entry.label)}
              max={entry.badgeMax}
            />
          )
        }
      />
    );
  }

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        // `aria-disabled` WITHOUT the native `disabled`: the row must stay
        // focusable and announced, because a destination whose capability has
        // not resolved is still a destination the user needs to find. A natively
        // disabled button drops out of the tab order, which would make the very
        // rows this branch exists to keep visible the ones a keyboard user
        // cannot reach. There is no handler, so it is inert either way.
        //
        // `aria-disabled:opacity-100` undoes the variant's own half-opacity.
        // That default assumes the row says nothing a user still needs to read,
        // which is exactly wrong here: it dims the state word this branch adds
        // for WCAG 1.4.1 to roughly 1.7:1 in light mode, making the one piece of
        // text carrying the meaning the least legible thing on the screen.
        aria-disabled="true"
        className="text-sm aria-disabled:opacity-100"
        tooltip={entry.label}
      >
        {icon}
        <span>{entry.label}</span>
        {stateWord === null ? null : (
          <span className="ml-auto text-muted-foreground text-xs">
            {stateWord}
          </span>
        )}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

/**
 * The badge's accessible name. An icon-adjacent number reads as a bare digit to
 * assistive tech, so it needs saying what it counts (WCAG 1.1.1) — and only the
 * destination's owner knows that, which is why `countNoun` comes from the
 * manifest and the fallback names the destination rather than guessing a noun.
 */
function badgeLabel(
  count: number,
  countNoun: NavigationCountNoun | undefined,
  destinationLabel: string
): string {
  return countNoun === undefined
    ? `${count} in ${destinationLabel}`
    : `${count} ${navigationCountNounFor(count, countNoun)}`;
}

function ShellSidebarControls({
  controlIds,
  renderControl,
}: {
  controlIds: readonly string[];
  renderControl?: (controlId: string) => ReactNode;
}) {
  if (renderControl === undefined) {
    return null;
  }
  return controlIds.map((controlId) => (
    <Fragment key={controlId}>{renderControl(controlId)}</Fragment>
  ));
}
