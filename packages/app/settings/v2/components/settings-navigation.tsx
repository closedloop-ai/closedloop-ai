"use client";

import {
  SETTINGS_PANEL_GROUP_LABEL,
  SETTINGS_PANEL_LABEL,
  SettingsPanelGroup,
  type SettingsPanelId,
} from "@repo/api/src/types/settings-panel";
import { buttonVariants } from "@repo/design-system/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@repo/design-system/components/ui/collapsible";
import { cn } from "@repo/design-system/lib/utils";
import { Link } from "@repo/navigation/link";
import {
  ChevronDownIcon,
  FlaskConicalIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useState } from "react";
import type {
  SettingsNavigationEntry,
  SettingsNavigationGroupModel,
} from "../lib/settings-navigation-model";
import type { SettingsPanelRegistry } from "../lib/settings-panel-registry";

type SettingsNavigationProps = {
  groups: readonly SettingsNavigationGroupModel[];
  registry: SettingsPanelRegistry;
  activePanelId: SettingsPanelId | null;
  buildPanelHref: (panelId: SettingsPanelId) => string;
};

const ENTRY_CLASS = "w-full justify-start gap-2.5 px-3";

// Selection reads as weight plus a NEUTRAL tint. A `secondary` button would put
// the product's green on the current row, and green here means passing, not
// "you are here".
const ACTIVE_ENTRY_CLASS = "bg-muted font-medium text-foreground";
const RESTING_ENTRY_CLASS = "font-normal text-muted-foreground";

function SettingsNavigationItem({
  entry,
  registry,
  isActive,
  href,
}: Readonly<{
  entry: SettingsNavigationEntry;
  registry: SettingsPanelRegistry;
  isActive: boolean;
  href: string;
}>) {
  const label = SETTINGS_PANEL_LABEL[entry.id];
  const Icon = registry.get(entry.id)?.icon;

  if (!entry.navigable) {
    // The label is a static lookup, so it is known even while the capability
    // read is not. Replacing it with a skeleton would hide something we have
    // and misreport WHICH fact is still pending.
    return (
      <p
        aria-busy={entry.ownsCapabilityError ? undefined : "true"}
        className={cn(
          buttonVariants({ variant: "ghost" }),
          ENTRY_CLASS,
          RESTING_ENTRY_CLASS,
          "pointer-events-none"
        )}
        data-settings-nav-state={entry.status}
      >
        {entry.ownsCapabilityError ? (
          <TriangleAlertIcon aria-hidden="true" className="size-4 shrink-0" />
        ) : (
          Icon && <Icon aria-hidden="true" className="size-4 shrink-0" />
        )}
        {label}
        {entry.ownsCapabilityError ? (
          <span className="sr-only">(access unknown)</span>
        ) : null}
      </p>
    );
  }

  return (
    <Link
      aria-current={isActive ? "page" : undefined}
      className={cn(
        buttonVariants({ variant: "ghost" }),
        ENTRY_CLASS,
        isActive ? ACTIVE_ENTRY_CLASS : RESTING_ENTRY_CLASS
      )}
      data-settings-nav-state="ready"
      href={href}
    >
      {Icon ? <Icon aria-hidden="true" className="size-4 shrink-0" /> : null}
      {label}
    </Link>
  );
}

function SettingsNavigationEntries({
  entries,
  registry,
  activePanelId,
  buildPanelHref,
  labelledBy,
}: Readonly<
  Omit<SettingsNavigationProps, "groups"> & {
    entries: readonly SettingsNavigationEntry[];
    labelledBy: string;
  }
>) {
  // A real list, not a bare div: it carries the group's accessible name and
  // gives a screen reader the item count, which `role="group"` alone does not.
  return (
    <ul aria-labelledby={labelledBy} className="space-y-1">
      {entries.map((entry) => (
        <li key={entry.id}>
          <SettingsNavigationItem
            entry={entry}
            href={buildPanelHref(entry.id)}
            isActive={entry.id === activePanelId}
            registry={registry}
          />
        </li>
      ))}
    </ul>
  );
}

/**
 * Typed groups rendered from the registry, in the contract's order rather than
 * registration order, so the nav does not reshuffle as panel packages land.
 * Labs collapses because it is the long tail, matching the prototype IA, and
 * opens when it holds the active panel so a Labs deep link is never hidden.
 */
export function SettingsNavigation({
  groups,
  registry,
  activePanelId,
  buildPanelHref,
}: Readonly<SettingsNavigationProps>) {
  return (
    <nav aria-label="Settings" className="flex min-h-0 flex-col gap-6">
      {groups.map(({ group, entries }) =>
        group === SettingsPanelGroup.Labs ? (
          <SettingsNavigationCollapsibleGroup
            activePanelId={activePanelId}
            buildPanelHref={buildPanelHref}
            entries={entries}
            group={group}
            key={group}
            registry={registry}
          />
        ) : (
          <div key={group}>
            <p
              className="mb-2 px-3 font-medium text-muted-foreground text-xs uppercase tracking-wide"
              id={`settings-nav-group-${group}`}
            >
              {SETTINGS_PANEL_GROUP_LABEL[group]}
            </p>
            <SettingsNavigationEntries
              activePanelId={activePanelId}
              buildPanelHref={buildPanelHref}
              entries={entries}
              labelledBy={`settings-nav-group-${group}`}
              registry={registry}
            />
          </div>
        )
      )}
    </nav>
  );
}

/**
 * The collapsible Labs group. Its open state is CONTROLLED, not seeded with
 * `defaultOpen`: the shell is not remounted when the route changes, so a
 * `defaultOpen` computed on the first render — when the capability read is still
 * pending and no panel is active yet — is the value Radix keeps forever. A Labs
 * deep link would then resolve into a group that stays shut, hiding the very
 * entry the user asked for.
 *
 * Opening is driven by the active panel CHANGING into this group rather than by
 * it merely being here, so a user who deliberately collapses Labs while sitting
 * on a Labs panel keeps it collapsed until they navigate again.
 */
function SettingsNavigationCollapsibleGroup({
  group,
  entries,
  registry,
  activePanelId,
  buildPanelHref,
}: Readonly<
  Omit<SettingsNavigationProps, "groups"> & {
    group: SettingsPanelGroup;
    entries: readonly SettingsNavigationEntry[];
  }
>) {
  const activeInGroup = entries.some((entry) => entry.id === activePanelId)
    ? activePanelId
    : null;
  const [open, setOpen] = useState(activeInGroup !== null);
  const [syncedActive, setSyncedActive] = useState(activeInGroup);

  // Adjusting state during render rather than in an effect: React re-renders
  // before committing, so the group is never painted shut for a frame with the
  // active entry inside it.
  if (syncedActive !== activeInGroup) {
    setSyncedActive(activeInGroup);
    if (activeInGroup !== null) {
      setOpen(true);
    }
  }

  const labelledBy = `settings-nav-group-${group}`;

  return (
    <Collapsible onOpenChange={setOpen} open={open}>
      <CollapsibleTrigger
        className={cn(
          buttonVariants({ size: "sm", variant: "ghost" }),
          "group w-full justify-start gap-2 px-3 font-medium text-muted-foreground text-xs uppercase tracking-wide"
        )}
        id={labelledBy}
      >
        <FlaskConicalIcon aria-hidden="true" className="size-3.5" />
        <span className="flex-1 text-left">
          {SETTINGS_PANEL_GROUP_LABEL[group]}
        </span>
        <ChevronDownIcon
          aria-hidden="true"
          className="size-3.5 transition-transform group-data-[state=open]:rotate-180"
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1">
        <SettingsNavigationEntries
          activePanelId={activePanelId}
          buildPanelHref={buildPanelHref}
          entries={entries}
          labelledBy={labelledBy}
          registry={registry}
        />
      </CollapsibleContent>
    </Collapsible>
  );
}
