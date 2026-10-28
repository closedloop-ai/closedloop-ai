// gardener-support: test and story data, not shipped
"use client";

import { type ComponentProps, useEffect, useRef, useState } from "react";
import { ArtifactCommentsToggle } from "../generic-artifact-surface/preview/components/artifact-comments-toggle";
import { CommentsPane } from "./comments-pane";
import type { CommentsPaneLoadStatus } from "./comments-pane-model";
import { useCommentsTabMemory } from "./comments-tab-memory";
import { useCommentsPaneDrafts } from "./use-comments-pane-drafts";

export type PaneStoryArgs = Omit<
  ComponentProps<typeof CommentsPane>,
  "drafts" | "onDraftChange" | "returnFocusRef" | "loadState" | "identity"
> & {
  /** The entity the host shows; drafts and in-flight writes belong to it. */
  identity?: string;
  /** One select control over the four load states (ISS-10550). */
  loadStatus: CommentsPaneLoadStatus;
};

/** Open and width are host state seeded from args, and follow the Controls. */
function useArgState<T>(value: T) {
  const [state, setState] = useState(value);
  useEffect(() => setState(value), [value]);
  return [state, setState] as const;
}

/**
 * A host the way the Wiring issue will build one: it owns open, width and
 * drafts, and puts the toggle the rail returns focus to beside it.
 */
export function PaneHost({
  identity = "story-artifact",
  loadStatus,
  ...args
}: Readonly<PaneStoryArgs>) {
  const [open, setOpen] = useArgState(args.open);
  const [width, setWidth] = useArgState(args.width);
  const { drafts, onDraftChange } = useCommentsPaneDrafts(identity);
  const triggerRef = useRef<HTMLDivElement>(null);
  return (
    <div className="flex h-[40rem] bg-background">
      <div className="flex-1 p-3" ref={triggerRef}>
        <ArtifactCommentsToggle
          onToggle={() => {
            setOpen(!open);
            args.onOpenChange(!open);
          }}
          open={open}
        />
      </div>
      <CommentsPane
        {...args}
        drafts={drafts}
        identity={identity}
        loadState={{ status: loadStatus }}
        onDraftChange={onDraftChange}
        onOpenChange={(next) => {
          setOpen(next);
          args.onOpenChange(next);
        }}
        onWidthChange={(next) => {
          setWidth(next);
          args.onWidthChange(next);
        }}
        open={open}
        returnFocusRef={{
          get current() {
            return triggerRef.current?.querySelector("button") ?? null;
          },
        }}
        width={width}
      />
    </div>
  );
}

const STORY_TABS = ["artifact", "sessions", "details"] as const;
type StoryTab = (typeof STORY_TABS)[number];
const TAB_LABELS: Record<StoryTab, string> = {
  artifact: "Artifact",
  details: "Details",
  sessions: "Sessions",
};
const HIDDEN_TABS: readonly StoryTab[] = ["details"];

/** A three-tab host proving per-tab open state, Details suppression and draft survival. */
export function TabbedPaneHost({
  identity = "story-artifact",
  loadStatus,
  ...args
}: Readonly<PaneStoryArgs>) {
  const [tab, setTab] = useState<StoryTab>("artifact");
  const [open, setOpen] = useState(args.open);
  const memory = useCommentsTabMemory<StoryTab>(
    { artifact: args.open },
    HIDDEN_TABS
  );
  const artifactDrafts = useCommentsPaneDrafts(identity);
  const sessionDrafts = useCommentsPaneDrafts(identity);
  const setRailOpen = (next: boolean) => {
    memory.remember(tab, next);
    setOpen(next);
    args.onOpenChange(next);
  };
  return (
    <div className="flex h-[40rem] flex-col bg-background">
      <div className="flex items-center gap-2 border-b p-2">
        {STORY_TABS.map((value) => (
          <button
            aria-pressed={tab === value}
            className="rounded px-2 py-1 text-sm aria-pressed:bg-accent"
            key={value}
            onClick={() => {
              const nextOpen = memory.changeTab(tab, value, open);
              setTab(value);
              setOpen(nextOpen);
            }}
            type="button"
          >
            {TAB_LABELS[value]}
          </button>
        ))}
        {tab === "details" ? null : (
          <ArtifactCommentsToggle
            onToggle={() => setRailOpen(!open)}
            open={open}
          />
        )}
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="flex-1" />
        {tab === "details" ? null : (
          <CommentsPane
            {...args}
            {...(tab === "sessions" ? sessionDrafts : artifactDrafts)}
            identity={identity}
            loadState={{ status: loadStatus }}
            onOpenChange={setRailOpen}
            open={open}
          />
        )}
      </div>
    </div>
  );
}
