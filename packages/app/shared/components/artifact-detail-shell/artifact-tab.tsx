"use client";

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@repo/design-system/components/ui/alert";
import { Button } from "@repo/design-system/components/ui/button";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import {
  CircleAlertIcon,
  FileTextIcon,
  LoaderCircleIcon,
  LockIcon,
  type LucideIcon,
} from "lucide-react";
import { type ReactNode, type Ref, useState } from "react";

/**
 * ISS-10791: the Artifact tab -- the shell's `artifact` panel. It owns the
 * canvas framing, the scroll container and the canvas lifecycle, and knows
 * nothing about the canvas itself, which the type's adapter passes in
 * (Documents, Issues, Sessions, Branches, Projects and Prototypes each bring
 * their own without forking the shell).
 *
 * Deliberately NOT here:
 * - What each type's canvas renders, and the header actions shown while this
 *   tab is active: ISS-10796/10797 (the shell's `headerActions` slot).
 * - Whole-page not-found/permission: `DetailStateShell`, above the shell.
 *   `permission` below is narrower: the page opened, but this viewer cannot
 *   see the artifact's content.
 * - The unsupported and partial/stale tab states: ISS-10790's shell.
 */

export type ArtifactTabState =
  | "ready"
  | "loading"
  | "empty"
  | "error"
  | "permission";

export type ArtifactTabAction = {
  icon?: LucideIcon;
  label: string;
  onSelect: () => void;
  variant?: "primary" | "secondary";
};

export type ArtifactTabStateContent = {
  action?: ArtifactTabAction;
  description?: string;
  icon?: LucideIcon;
  title?: string;
};

/**
 * - `framed` (default): the document-style card. The tab owns scrolling and
 *   exposes the scroll container through `scrollRef`, so a canvas that
 *   leaves scrolling to the tab can still bring a row into view.
 * - `flush`: no card; the canvas fills the tab and owns its own scrolling
 *   (a canvas with its own single scroll area such as Session's timeline +
 *   trace, Branch's workspace, the prototype browser).
 */
export type ArtifactTabFrame = "framed" | "flush";

type ArtifactTabStateDefaults = {
  description: string;
  icon: LucideIcon;
  title: string;
};

/**
 * Default wording for loading/empty/error, moved unchanged from the
 * prototype's `defaultArtifactShellStates` (origin/main) so it is not new copy.
 * `permission` has NO default: its wording must come from the adopting host
 * (root AGENTS.md, Human Provenance). The prop types require a title and
 * description whenever `stateContent.permission` is passed; a host that
 * shows `permission` without it gets the lock alone, never an empty heading.
 */
const DEFAULT_STATE_CONTENT: Readonly<
  Record<
    Exclude<ArtifactTabState, "ready" | "permission">,
    ArtifactTabStateDefaults
  >
> = {
  loading: {
    description: "Preparing the artifact viewer and its latest content.",
    icon: LoaderCircleIcon,
    title: "Loading artifact",
  },
  empty: {
    description: "This artifact does not have any content to display yet.",
    icon: FileTextIcon,
    title: "Nothing to show yet",
  },
  error: {
    description: "The artifact could not be loaded. Try again in a moment.",
    icon: CircleAlertIcon,
    title: "Unable to load artifact",
  },
};

type ArtifactTabPermissionContent = ArtifactTabStateContent & {
  description: string;
  title: string;
};

type ArtifactTabStateContentMap = Readonly<{
  empty?: ArtifactTabStateContent;
  error?: ArtifactTabStateContent;
  /**
   * Loading renders a live status and skeletons, never a button, so this
   * variant carries no `action`: one passed here would typecheck and never
   * render (whitlockk, ISS-10791 review).
   */
  loading?: Omit<ArtifactTabStateContent, "action">;
  permission?: ArtifactTabPermissionContent;
}>;

type ArtifactTabBaseProps = {
  /**
   * The type-supplied canvas. Rendered in `ready`, and kept mounted through a
   * later `loading` (a background refetch) so its drafts, scroll position and
   * open comments survive. A `loading` with no canvas mounted (first paint,
   * or a retry after `empty`/`error`/`permission`) shows the skeleton.
   * `empty`, `error` and `permission` always replace it.
   *
   * That "canvas is mounted" memory belongs to ONE artifact: a host that swaps in
   * a different artifact must remount the tab (key it by the artifact's id),
   * or the new artifact's first load shows the old canvas instead of the
   * skeleton.
   */
  canvas: ReactNode;
  /** Accessible name of the canvas region. */
  label?: string;
  /** Default: `ready`. */
  state?: ArtifactTabState;
  /**
   * Per-state wording and actions, over the shared defaults. `permission`
   * has no default wording: a host that can show it passes its own title and
   * description here (root AGENTS.md, Human Provenance).
   */
  stateContent?: ArtifactTabStateContentMap;
};

type ArtifactTabFramedProps = ArtifactTabBaseProps & {
  frame?: "framed";
  /** The tab-owned scroll container, for canvases that scroll to a row. */
  scrollRef?: Ref<HTMLElement>;
};

type ArtifactTabFlushProps = ArtifactTabBaseProps & {
  frame: "flush";
  /**
   * There is no tab-owned scroll container to hand back in the `flush` frame,
   * so this is unrepresentable rather than accepted and dropped
   * (marisolashgrove, ISS-10791 review). `never` is what makes it an error:
   * excess-property checking alone lets a key through when any member of the
   * union declares it.
   */
  scrollRef?: never;
};

/** Discriminated on `frame` so neither variant accepts a prop it ignores. */
export type ArtifactTabProps = ArtifactTabFramedProps | ArtifactTabFlushProps;

export function ArtifactTab({
  canvas,
  frame = "framed",
  label = "Artifact viewer and editor canvas",
  scrollRef,
  state = "ready",
  stateContent,
}: ArtifactTabProps) {
  // Whether the canvas is mounted right now. Only a loading that follows a
  // mounted canvas keeps it; after empty/error/permission there is nothing
  // left to keep, so a retry starts from the skeleton again.
  const [canvasMounted, setCanvasMounted] = useState(state === "ready");
  const refreshing = state === "loading" && canvasMounted;
  const showsCanvas = state === "ready" || refreshing;
  if (showsCanvas !== canvasMounted) {
    setCanvasMounted(showsCanvas);
  }
  const body = showsCanvas ? (
    canvas
  ) : (
    <ArtifactTabStateBody content={stateContent?.[state]} state={state} />
  );

  if (frame === "flush") {
    return (
      <section
        aria-busy={refreshing || undefined}
        aria-label={label}
        className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background"
        data-artifact-canvas-state={state}
        data-artifact-frame="flush"
      >
        {body}
      </section>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-muted/30 p-4">
      <section
        aria-busy={refreshing || undefined}
        aria-label={label}
        className="relative flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden rounded-lg border bg-background shadow-sm"
        data-artifact-canvas-state={state}
        data-artifact-frame="framed"
        ref={scrollRef}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the tab owns this scroll container, so it must be reachable by keyboard even when the canvas has nothing focusable (WCAG 2.1.1; axe scrollable-region-focusable).
        tabIndex={0}
      >
        {body}
      </section>
    </div>
  );
}

function ArtifactTabStateBody({
  content,
  state,
}: {
  content: ArtifactTabStateContent | undefined;
  state: Exclude<ArtifactTabState, "ready">;
}) {
  const defaults =
    state === "permission" ? undefined : DEFAULT_STATE_CONTENT[state];
  const title = content?.title ?? defaults?.title;
  const description = content?.description ?? defaults?.description;
  const StateIcon = content?.icon ?? defaults?.icon ?? LockIcon;
  const action = content?.action;

  if (state === "loading") {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <div
          aria-live="polite"
          className="w-full max-w-sm space-y-5 text-center"
          role="status"
        >
          <StateIcon
            aria-hidden="true"
            className="mx-auto size-5 animate-spin text-muted-foreground"
          />
          <div>
            <h2 className="font-medium text-sm">{title}</h2>
            <p className="mt-1 text-muted-foreground text-sm">{description}</p>
          </div>
          <div aria-hidden="true" className="space-y-2">
            <Skeleton className="mx-auto h-3 w-4/5" />
            <Skeleton className="mx-auto h-3 w-full" />
            <Skeleton className="mx-auto h-3 w-3/5" />
          </div>
        </div>
      </div>
    );
  }

  if (state === "error") {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <Alert className="max-w-md" variant="error">
          <StateIcon aria-hidden="true" />
          <AlertTitle>{title}</AlertTitle>
          <AlertDescription>
            <p>{description}</p>
            {action ? (
              <ArtifactTabActionButton action={action} placement="alert" />
            ) : null}
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  // empty and permission: a calm centred message. Permission uses a lock
  // and its own wording so it never reads as "nothing here yet".
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="max-w-sm text-center">
        <StateIcon
          aria-hidden="true"
          className="mx-auto size-6 text-muted-foreground"
        />
        {title ? <h2 className="mt-3 font-medium text-sm">{title}</h2> : null}
        {description ? (
          <p className="mt-1 text-muted-foreground text-sm">{description}</p>
        ) : null}
        {action ? <ArtifactTabActionButton action={action} /> : null}
      </div>
    </div>
  );
}

function ArtifactTabActionButton({
  action,
  placement = "message",
}: {
  action: ArtifactTabAction;
  placement?: "alert" | "message";
}) {
  const ActionIcon = action.icon;
  // Inside the error alert the action is always a quiet outline button, so
  // a primary fill never sits on the error surface.
  const inAlert = placement === "alert";
  return (
    <Button
      className={inAlert ? "mt-2" : "mt-4"}
      onClick={action.onSelect}
      size="sm"
      variant={
        inAlert || action.variant === "secondary" ? "outline" : "default"
      }
    >
      {ActionIcon ? <ActionIcon aria-hidden="true" /> : null}
      {action.label}
    </Button>
  );
}
