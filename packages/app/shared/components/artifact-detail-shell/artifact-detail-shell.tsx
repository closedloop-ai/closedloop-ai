"use client";

import {
  ARTIFACT_DETAIL_TAB_LABELS,
  ArtifactDetailTab,
} from "@repo/app/shared/lib/artifact-detail-tab";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@repo/design-system/components/ui/alert";
import { Button } from "@repo/design-system/components/ui/button";
import {
  UnderlineTabsList,
  UnderlineTabsTrigger,
} from "@repo/design-system/components/ui/primitives/underline-tabs";
import { Tabs, TabsContent } from "@repo/design-system/components/ui/tabs";
import { useContainerWidth } from "@repo/design-system/hooks/use-container-width";
import {
  CircleAlertIcon,
  CircleDashedIcon,
  TriangleAlertIcon,
} from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

/**
 * ISS-10790: the canonical Artifact / Details / Sessions / Activity shell,
 * promoted out of the prototype's generic-artifact-detail-shell.tsx.
 *
 * Content-agnostic and domain-free. It owns the tab bar, the controlled
 * tab/panel relationship, the per-type availability set, two generic
 * tab-level states (unsupported, partial/stale), the header action slots and
 * the comments drawer mount point. It also owns tab focus restoration and
 * narrow overflow. It owns nothing about what a tab shows.
 *
 * Deliberately NOT here (each has its own ticket):
 * - Loading/empty/error/permission inside a tab and the Artifact canvas
 *   framing: ISS-10791 (Artifact), ISS-10792 (Details), ISS-10793 (Sessions).
 * - Whole-entity not-found/permission: `DetailStateShell`, one layer above.
 * - Breadcrumb, title and identity: page chrome in the host (ISS-10796/10797).
 * - The comments rail itself -- open/closed, width, resize, breakpoints and
 *   per-tab memory: ISS-11209 (the comments pane; ISS-10794 was retired
 *   into ISS-11209-11213). ISS-11213 mounts it into `comments`.
 * - URL state, legacy tab aliases and back/forward: the ISS-10795 route hook
 *   uses the navigation port outside this controlled shell.
 *
 * The fourth tab is Activity: ISS-10789 settled four tabs, and the
 * 2026-09-23 kick-off (ISS-10843 v11) renamed Revisions -> Activity. Trace is
 * not a tab (PRD-706 roadmap backlog).
 */

/**
 * The content width of every tab body on an artifact detail page (Nerys,
 * 2026-10-08): left-aligned, filling the page up to a Full HD (1920px)
 * browser and capped there. 1648px is the page's inner width at 1920: the
 * browser less the 256px Global Nav and the app frame's 8px gutters. Each
 * body is left-aligned, never centered, so its left edge holds still across
 * tabs.
 */
export const ARTIFACT_DETAIL_CONTENT_WIDTH_CLASS = "max-w-[1648px]";

/**
 * A tab-level state the shell renders itself, so every host lays it out the
 * same way. The states come from ISS-10790's contract ("partial/stale",
 * "unsupported panel data is distinct from an empty successful result; do not
 * silently hide Revisions"). The shell ships NO wording: every title and
 * description is the host's, so user-visible copy traces to the adopting
 * ticket (root AGENTS.md, Human Provenance).
 *
 * - `unsupported`: the tab exists for this type but has no data source yet
 *   (Branch Activity until ISS-10980). It replaces the tab body, reads
 *   differently from an empty successful result, and the tab is never hidden
 *   to avoid it.
 * - `partial` / `stale`: the tab body still renders, under a notice about
 *   THIS tab's data. `tone` is the host's severity call, not the shell's. A
 *   page-level alert (Branch's "Latest branch details unavailable", an error
 *   above the tab bar today) is page chrome and stays with the host above the
 *   shell; it is not a tab state.
 */
export const ArtifactDetailTabStateKind = {
  Unsupported: "unsupported",
  Partial: "partial",
  Stale: "stale",
} as const;
export type ArtifactDetailTabStateKind =
  (typeof ArtifactDetailTabStateKind)[keyof typeof ArtifactDetailTabStateKind];

export const ArtifactDetailNoticeTone = {
  Warning: "warning",
  Error: "error",
} as const;
export type ArtifactDetailNoticeTone =
  (typeof ArtifactDetailNoticeTone)[keyof typeof ArtifactDetailNoticeTone];

export type ArtifactDetailTabState =
  | {
      description: ReactNode;
      kind: typeof ArtifactDetailTabStateKind.Unsupported;
      title: string;
    }
  | {
      action?: { label: string; onSelect: () => void };
      description?: ReactNode;
      kind:
        | typeof ArtifactDetailTabStateKind.Partial
        | typeof ArtifactDetailTabStateKind.Stale;
      title: string;
      tone: ArtifactDetailNoticeTone;
    };

/**
 * The tab the shell actually shows: `activeTab` when it is configured,
 * otherwise the first configured tab. This is only the last-line guard so a
 * bad value never reveals a tab the type does not have; mapping URLs and
 * legacy aliases onto a valid tab is ISS-10795's job, before this is reached.
 */
export function resolveArtifactDetailTab<Tab extends ArtifactDetailTab>(
  activeTab: ArtifactDetailTab,
  tabs: readonly Tab[]
): Tab | undefined {
  return tabs.find((tab) => tab === activeTab) ?? tabs[0];
}

export type ArtifactDetailShellProps<Tab extends ArtifactDetailTab> = {
  /**
   * Controlled: which tab the host wants shown. A value outside `tabs`
   * falls back to the first configured tab (see resolveArtifactDetailTab).
   */
  activeTab: ArtifactDetailTab;
  /**
   * The comments drawer mount point, rendered beside the tab panels. The host
   * decides per tab what goes here (nothing on Details today); the rail's own
   * behaviour is ISS-11209's (ISS-11213 wires it).
   */
  comments?: ReactNode;
  /**
   * Shown only while one of `headerActionsTabs` is active. The header wraps
   * at narrow widths, so a long action set moves onto its own row instead of
   * overflowing the tab bar.
   */
  headerActions?: ReactNode;
  /**
   * Which tabs show `headerActions`. Default: Artifact only, matching today's
   * per-tab affordance. Hosts pass their own set (see ISS-10964).
   */
  headerActionsTabs?: readonly Tab[];
  /** Trailing header content, shown on every tab. */
  headerEnd?: ReactNode;
  /**
   * A row under the tab bar, shown on every tab and outside the scrolling
   * panel, so it stays in view (ISS-12578: an issue's status strip, ruled on
   * ISS-12570).
   */
  belowTabs?: ReactNode;
  /** Fires on every tab change; the host owns whether `activeTab` updates. */
  onActiveTabChange: (tab: Tab) => void;
  /**
   * A body for every configured tab and no others, so a host cannot forget
   * one and get blank space, and a Session host never has to invent a
   * Sessions body.
   */
  panels: Readonly<Record<Tab, ReactNode>>;
  /**
   * Tabs that stay mounted (hidden) after the user leaves them, for panels
   * whose state must survive a switch (Branch Sessions' selected PR, trace
   * scroll, playhead). Default: none -- an inactive tab unmounts, exactly as
   * today's Session and Branch pages do, so a visited tab's queries do not
   * stay live and refetch in the background (packages/app/AGENTS.md: avoid
   * reflexive on-mount fetching). A host that keeps a tab mounted owns gating
   * that tab's queries on visibility, deriving its `active`/`enabled` input
   * from `activeTab === tab`. Key the shell by entity identity so visited
   * panels and their retained state reset when navigating to another entity.
   */
  keepMountedTabs?: readonly Tab[];
  /** Notify the routing host after the selected panel's body has mounted. */
  onActivePanelReady?: (tab: Tab) => void;
  /**
   * Per-tab label overrides for a type whose record makes the shared wording
   * wrong -- a Session's one Sessions tab reads "Session" (ISS-12167). Keyed
   * by tab so the URL key is unaffected; an unlisted tab keeps its shared
   * label.
   */
  tabLabels?: Readonly<Partial<Record<Tab, string>>>;
  /**
   * Accessible name for the tab list. Default is the prototype's existing
   * name, cited in ISS-10790's evidence ("tablist Artifact detail sections").
   */
  tabListLabel?: string;
  /** Optional per-tab state the shell renders around or instead of the body. */
  tabStates?: Readonly<Partial<Record<Tab, ArtifactDetailTabState>>>;
  /**
   * The tabs this type has, in order. Absent tabs render nothing at all: no
   * trigger, no disabled state, no empty state.
   */
  tabs: readonly Tab[];
};

export function ArtifactDetailShell<Tab extends ArtifactDetailTab>({
  activeTab,
  belowTabs,
  comments,
  headerActions,
  headerActionsTabs,
  headerEnd,
  keepMountedTabs,
  onActivePanelReady,
  onActiveTabChange,
  panels,
  tabLabels,
  tabListLabel = "Artifact detail sections",
  tabStates,
  tabs,
}: ArtifactDetailShellProps<Tab>) {
  const shownTab = resolveArtifactDetailTab(activeTab, tabs);
  const activeTriggerRef = useRef<HTMLButtonElement>(null);
  const previousTabRef = useRef(shownTab);
  const viewportElementRef = useRef<HTMLDivElement>(null);
  const {
    ref: measureViewport,
    width: viewportWidth,
    measured: viewportMeasured,
  } = useContainerWidth<HTMLDivElement>();
  const {
    ref: tabListRef,
    width: tabListWidth,
    measured: tabListMeasured,
  } = useContainerWidth<HTMLDivElement>();
  const viewportRef = useCallback(
    (element: HTMLDivElement | null) => {
      viewportElementRef.current = element;
      measureViewport(element);
    },
    [measureViewport]
  );
  useLayoutEffect(() => {
    if (previousTabRef.current !== shownTab) {
      activeTriggerRef.current?.focus({ preventScroll: true });
    }
    previousTabRef.current = shownTab;
    // Cold deep links need visibility without taking initial document focus.
    if (viewportMeasured && tabListMeasured && tabListWidth > viewportWidth) {
      revealTabInViewport(viewportElementRef.current, activeTriggerRef.current);
    }
  }, [
    shownTab,
    viewportWidth,
    tabListWidth,
    viewportMeasured,
    tabListMeasured,
  ]);
  // Only tabs the host lists in `keepMountedTabs` stay mounted after a
  // visit; every other inactive tab unmounts. Tabs never shown are never
  // mounted.
  const [visitedTabs, setVisitedTabs] = useState<ReadonlySet<Tab>>(
    () => new Set(shownTab ? [shownTab] : [])
  );
  if (shownTab && !visitedTabs.has(shownTab)) {
    setVisitedTabs(new Set([...visitedTabs, shownTab]));
  }
  const actionTabs: readonly ArtifactDetailTab[] = headerActionsTabs ?? [
    ArtifactDetailTab.Artifact,
  ];
  const showHeaderActions =
    shownTab !== undefined && actionTabs.includes(shownTab);

  return (
    <Tabs
      className="relative min-h-0 flex-1 flex-row gap-0"
      data-slot="artifact-detail-shell"
      onValueChange={(value) => {
        const next = tabs.find((tab) => tab === value);
        if (next) {
          onActiveTabChange(next);
        }
      }}
      value={shownTab ?? ""}
    >
      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-h-12 shrink-0 flex-wrap items-end justify-between gap-x-3 gap-y-1 border-b px-4">
          <div
            className="-mx-1 min-w-0 basis-full scroll-p-1 overflow-x-auto p-1 sm:flex-1 sm:basis-auto"
            data-slot="artifact-detail-tabs-viewport"
            ref={viewportRef}
          >
            <UnderlineTabsList
              aria-label={tabListLabel}
              className="w-max min-w-full border-b-0 px-0 pt-0"
              ref={tabListRef}
            >
              {tabs.map((value) => (
                <UnderlineTabsTrigger
                  className="h-10 px-3 py-0 text-sm"
                  key={value}
                  ref={value === shownTab ? activeTriggerRef : undefined}
                  value={value}
                >
                  {tabLabels?.[value] ?? ARTIFACT_DETAIL_TAB_LABELS[value]}
                </UnderlineTabsTrigger>
              ))}
            </UnderlineTabsList>
          </div>
          <div className="mb-2 flex min-w-0 flex-wrap items-center justify-end gap-2">
            {showHeaderActions ? headerActions : null}
            {headerEnd}
          </div>
        </div>
        {belowTabs ? (
          <div
            className="shrink-0 border-b px-4 py-2"
            data-slot="artifact-detail-below-tabs"
          >
            {belowTabs}
          </div>
        ) : null}

        {tabs.map((value) => {
          const selected = value === shownTab;
          const mounted =
            selected ||
            (visitedTabs.has(value) &&
              keepMountedTabs?.includes(value) === true);
          return (
            <TabsContent
              className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
              forceMount={mounted ? true : undefined}
              hidden={!selected}
              key={value}
              value={value}
            >
              {mounted ? (
                <ArtifactDetailTabBody
                  onReady={onActivePanelReady}
                  selected={selected}
                  state={tabStates?.[value]}
                  tab={value}
                >
                  {panels[value]}
                </ArtifactDetailTabBody>
              ) : null}
            </TabsContent>
          );
        })}
      </section>

      {comments}
    </Tabs>
  );
}

function ArtifactDetailTabBody<Tab extends ArtifactDetailTab>({
  children,
  onReady,
  selected,
  state,
  tab,
}: {
  children: ReactNode;
  onReady?: (tab: Tab) => void;
  selected: boolean;
  state: ArtifactDetailTabState | undefined;
  tab: Tab;
}) {
  useEffect(() => {
    if (selected) {
      onReady?.(tab);
    }
  }, [onReady, selected, tab]);
  if (state?.kind === ArtifactDetailTabStateKind.Unsupported) {
    return (
      <div
        className="flex min-h-0 flex-1 items-center justify-center p-6"
        data-artifact-tab-state={state.kind}
      >
        <div className="flex max-w-sm flex-col items-center gap-2 text-center">
          <CircleDashedIcon
            aria-hidden="true"
            className="size-6 text-muted-foreground"
          />
          <p className="font-medium text-sm">{state.title}</p>
          <p className="text-muted-foreground text-sm">{state.description}</p>
        </div>
      </div>
    );
  }
  if (state) {
    const NoticeIcon =
      state.tone === ArtifactDetailNoticeTone.Error
        ? CircleAlertIcon
        : TriangleAlertIcon;
    return (
      <>
        <Alert
          className="mx-4 mt-4 w-auto shrink-0"
          data-artifact-tab-state={state.kind}
          variant={state.tone}
        >
          <NoticeIcon aria-hidden="true" />
          <AlertTitle>{state.title}</AlertTitle>
          {state.description || state.action ? (
            <AlertDescription>
              {state.description}
              {state.action ? (
                <Button
                  className="mt-2"
                  onClick={state.action.onSelect}
                  size="sm"
                  variant="outline"
                >
                  {state.action.label}
                </Button>
              ) : null}
            </AlertDescription>
          ) : null}
        </Alert>
        {children}
      </>
    );
  }
  return children;
}

/** Keep the trigger and its focus ring visible without moving an outer scroller. */
function revealTabInViewport(
  viewport: HTMLDivElement | null,
  trigger: HTMLButtonElement | null
) {
  if (!(viewport && trigger) || viewport.clientWidth === 0) {
    return;
  }
  const viewportBounds = viewport.getBoundingClientRect();
  const triggerBounds = trigger.getBoundingClientRect();
  const style = globalThis.getComputedStyle(viewport);
  const left =
    viewportBounds.left +
    viewport.clientLeft +
    (Number.parseFloat(style.scrollPaddingLeft) || 0);
  const right =
    viewportBounds.left +
    viewport.clientLeft +
    viewport.clientWidth -
    (Number.parseFloat(style.scrollPaddingRight) || 0);
  if (triggerBounds.left < left) {
    viewport.scrollLeft += triggerBounds.left - left;
  } else if (triggerBounds.right > right) {
    viewport.scrollLeft += triggerBounds.right - right;
  }
}
