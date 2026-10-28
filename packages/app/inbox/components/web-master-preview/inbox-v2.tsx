"use client";

import {
  Avatar,
  AvatarFallback,
  avatarInitial,
} from "@repo/design-system/components/ui/avatar";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import { CHIP_FOCUS_RING_CLASS } from "@repo/design-system/components/ui/chip";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { Separator } from "@repo/design-system/components/ui/separator";
import { Textarea } from "@repo/design-system/components/ui/textarea";
import { cn } from "@repo/design-system/lib/utils";
import { useNavigation } from "@repo/navigation/use-navigation";
import { usePath } from "@repo/navigation/use-path";
import { useSearchParamsValue } from "@repo/navigation/use-search-params-value";
import {
  ArchiveIcon,
  BookmarkIcon,
  CheckIcon,
  ChevronDownIcon,
  FilterIcon,
  MailIcon,
  MailOpenIcon,
  RotateCcwIcon,
} from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { PageChrome } from "../../../shell/v2/components/web-master-preview/components/page-chrome"; // Cross-slice: mounted inside the Web Master preview shell (ISS-12938).
import {
  clampListWidth,
  countArchivedActionable,
  countNeedsAttention,
  DEFAULT_LIST_WIDTH,
  getPrimaryThreadMessage,
  InboxQueryKey,
  readInboxQueryState,
  selectVisibleThreads,
  typeFiltersParam,
  unreadOnlyParam,
} from "./inbox-v2-model";
import {
  AnchoredPreview,
  artifactIcons,
  InboxEmpty,
  RowAction,
} from "./inbox-v2-preview";
import {
  ArtifactType,
  InboxOrder,
  InboxView,
  Reason,
  seedThreads,
  type Thread,
  viewLabels,
} from "./inbox-v2-threads";

const LEFT_WIDTH_STORAGE_KEY = "inbox-v2-left-width";
const KEYBOARD_RESIZE_STEP = 24;
const CURRENT_USER = { initials: "AE", name: "Ottilie Eastwick" };

export function InboxV2() {
  const navigation = useNavigation();
  const pathname = usePath();
  const searchParams = useSearchParamsValue();
  const { order, selectedId, typeFilters, unreadOnly, view } =
    readInboxQueryState(new URLSearchParams(searchParams.toString()));
  const [threads, setThreads] = useState(() => [...seedThreads]);
  const [archived, setArchived] = useState<string[]>([]);
  const [bookmarked, setBookmarked] = useState<string[]>([
    "thread-prototype-1",
  ]);
  const [leftWidth, setLeftWidth] = useState(DEFAULT_LIST_WIDTH);
  const workspaceRef = useRef<HTMLDivElement>(null);

  // Restore, keyboard, pointer, and workspace resize all route through the same
  // container clamp, so neither a stored width nor the default can exceed the
  // room available — at the 390px sandbox width the list would otherwise clip.
  useEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) {
      return;
    }
    const applyClamp = () => {
      const available = workspace.getBoundingClientRect().width;
      setLeftWidth((width) => clampListWidth(width, available));
    };
    const saved = Number(
      globalThis.window.localStorage.getItem(LEFT_WIDTH_STORAGE_KEY)
    );
    if (Number.isFinite(saved) && saved > 0) {
      setLeftWidth(saved);
    }
    applyClamp();
    const observer = new ResizeObserver(applyClamp);
    observer.observe(workspace);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    globalThis.window.localStorage.setItem(
      LEFT_WIDTH_STORAGE_KEY,
      String(leftWidth)
    );
  }, [leftWidth]);

  const updateUrl = useCallback(
    (updates: Record<string, string | null>) => {
      const next = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(updates)) {
        if (value === null) {
          next.delete(key);
        } else {
          next.set(key, value);
        }
      }
      const query = next.toString();
      navigation.replace(query ? `${pathname}?${query}` : pathname, {
        scroll: false,
      });
    },
    [navigation, pathname, searchParams]
  );

  const actionableCount = countNeedsAttention(threads, archived);
  const archivedActionableCount = countArchivedActionable(threads, archived);

  const visible = useMemo(
    () =>
      selectVisibleThreads({
        archivedIds: archived,
        bookmarkedIds: bookmarked,
        order,
        selectedId,
        threads,
        typeFilters,
        unreadOnly,
        view,
      }),
    [
      archived,
      bookmarked,
      order,
      selectedId,
      threads,
      typeFilters,
      unreadOnly,
      view,
    ]
  );

  const selected =
    visible.find((thread) => thread.id === selectedId) ?? visible[0];
  const select = useCallback(
    (id: string) => {
      setThreads((items) =>
        items.map((item) =>
          item.id === id ? { ...item, unread: false } : item
        )
      );
      updateUrl({ [InboxQueryKey.Thread]: id });
    },
    [updateUrl]
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement
      ) {
        return;
      }
      const index = Math.max(
        0,
        visible.findIndex((thread) => thread.id === selected?.id)
      );
      if (["j", "ArrowDown", "k", "ArrowUp"].includes(event.key)) {
        event.preventDefault();
        const delta = event.key === "j" || event.key === "ArrowDown" ? 1 : -1;
        const next =
          visible[Math.min(visible.length - 1, Math.max(0, index + delta))];
        if (next) {
          select(next.id);
        }
      }
    };
    globalThis.window.addEventListener("keydown", onKeyDown);
    return () => globalThis.window.removeEventListener("keydown", onKeyDown);
  }, [select, selected, visible]);

  const patchThread = (id: string, patch: Partial<Thread>) =>
    setThreads((items) =>
      items.map((item) => (item.id === id ? { ...item, ...patch } : item))
    );
  const appendReply = (id: string, body: string) =>
    setThreads((items) =>
      items.map((item) =>
        item.id === id
          ? {
              ...item,
              replies: [
                ...item.replies,
                {
                  author: CURRENT_USER.name,
                  body,
                  initials: CURRENT_USER.initials,
                  time: "now",
                },
              ],
              unread: false,
            }
          : item
      )
    );
  const toggleArchive = (id: string) =>
    setArchived((ids) =>
      ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id]
    );
  const toggleBookmark = (id: string) =>
    setBookmarked((ids) =>
      ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id]
    );

  const resizeTo = (width: number) => {
    const workspace = workspaceRef.current;
    if (!workspace) {
      return;
    }
    setLeftWidth(
      clampListWidth(width, workspace.getBoundingClientRect().width)
    );
  };

  const startResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const workspace = workspaceRef.current;
    if (!workspace) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    const rect = workspace.getBoundingClientRect();
    const move = (pointerEvent: PointerEvent) => {
      setLeftWidth(
        clampListWidth(pointerEvent.clientX - rect.left, rect.width)
      );
    };
    const up = () => {
      globalThis.window.removeEventListener("pointermove", move);
      globalThis.window.removeEventListener("pointerup", up);
    };
    globalThis.window.addEventListener("pointermove", move);
    globalThis.window.addEventListener("pointerup", up);
  };

  return (
    <PageChrome breadcrumbs={[{ label: "Inbox", isCurrent: true }]}>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex min-h-12 shrink-0 items-center gap-1 overflow-x-auto border-b px-3">
          {(Object.keys(viewLabels) as InboxView[]).map((item) => (
            <Button
              aria-pressed={view === item}
              className={cn("shrink-0", view === item && "bg-muted")}
              key={item}
              onClick={() =>
                updateUrl({
                  [InboxQueryKey.Thread]: null,
                  [InboxQueryKey.View]: item,
                })
              }
              size="sm"
              variant="ghost"
            >
              {item === InboxView.Bookmarks ? <BookmarkIcon /> : null}
              {item === InboxView.Archive ? <ArchiveIcon /> : null}
              {viewLabels[item]}
              {item === InboxView.Attention ? (
                <Badge variant="error">{actionableCount}</Badge>
              ) : null}
            </Button>
          ))}
          <Separator className="mx-2 h-5" orientation="vertical" />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline">
                <FilterIcon /> Filter
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-60">
              <DropdownMenuCheckboxItem
                checked={unreadOnly}
                onCheckedChange={(checked) =>
                  updateUrl({
                    [InboxQueryKey.UnreadOnly]: unreadOnlyParam(checked),
                  })
                }
              >
                Unread only
              </DropdownMenuCheckboxItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Artifact type</DropdownMenuLabel>
              {Object.values(ArtifactType).map((type) => (
                <DropdownMenuCheckboxItem
                  checked={typeFilters.includes(type)}
                  key={type}
                  onCheckedChange={(checked) =>
                    updateUrl({
                      [InboxQueryKey.Types]: typeFiltersParam(
                        checked
                          ? [...typeFilters, type]
                          : typeFilters.filter((value) => value !== type)
                      ),
                    })
                  }
                >
                  {type[0].toUpperCase() + type.slice(1)}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline">
                {order === InboxOrder.Newest ? "Newest" : "Oldest"}
                <ChevronDownIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuRadioGroup
                onValueChange={(value) =>
                  updateUrl({ [InboxQueryKey.Order]: value })
                }
                value={order}
              >
                <DropdownMenuRadioItem value={InboxOrder.Newest}>
                  Newest activity
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value={InboxOrder.Oldest}>
                  Oldest activity
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <span className="ml-auto shrink-0 text-muted-foreground text-xs">
            {archivedActionableCount
              ? `${archivedActionableCount} unresolved archived`
              : "Resolve all actionable threads to reach inbox zero"}
          </span>
        </div>

        <div
          className="relative flex min-h-0 flex-1"
          ref={workspaceRef}
          style={
            { "--inbox-list-width": `${leftWidth}px` } as React.CSSProperties
          }
        >
          {/* The split turns on at lg, not md: MIN_LIST_WIDTH + MIN_PREVIEW_WIDTH
              is 740px of workspace, and md leaves only ~512 beside the sidebar,
              which would starve the preview. Below lg the panes stack, so the
              resizable width applies only where both minimums genuinely fit. */}
          <section
            aria-label="Comment threads"
            className={cn(
              "min-h-0 w-full shrink-0 overflow-auto border-r lg:w-(--inbox-list-width)",
              selectedId && "hidden lg:block"
            )}
          >
            {visible.length ? (
              visible.map((thread) => (
                <ThreadRow
                  archived={archived.includes(thread.id)}
                  bookmarked={bookmarked.includes(thread.id)}
                  key={thread.id}
                  onArchive={() => toggleArchive(thread.id)}
                  onBookmark={() => toggleBookmark(thread.id)}
                  onRead={() =>
                    patchThread(thread.id, { unread: !thread.unread })
                  }
                  onReply={(body) => appendReply(thread.id, body)}
                  onResolve={() =>
                    patchThread(thread.id, {
                      resolved: !thread.resolved,
                      unread: false,
                    })
                  }
                  onSelect={() => select(thread.id)}
                  selected={selected?.id === thread.id}
                  thread={thread}
                  view={view}
                />
              ))
            ) : (
              <InboxEmpty view={view} />
            )}
          </section>

          <button
            aria-label="Resize comment thread list"
            className="group absolute inset-y-0 z-10 hidden w-2 -translate-x-1/2 cursor-col-resize items-center justify-center lg:left-(--inbox-list-width) lg:flex"
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
                return;
              }
              event.preventDefault();
              resizeTo(
                leftWidth +
                  (event.key === "ArrowRight"
                    ? KEYBOARD_RESIZE_STEP
                    : -KEYBOARD_RESIZE_STEP)
              );
            }}
            onPointerDown={startResize}
            type="button"
          >
            <span className="h-10 w-0.5 rounded-full bg-border transition-colors group-hover:bg-primary group-focus-visible:bg-primary" />
          </button>

          <section
            aria-label="Anchored artifact preview"
            className={cn(
              "min-h-0 min-w-0 flex-1 overflow-hidden",
              !selectedId && "hidden lg:block"
            )}
          >
            {selected ? (
              <AnchoredPreview
                archived={archived.includes(selected.id)}
                bookmarked={bookmarked.includes(selected.id)}
                onArchive={() => toggleArchive(selected.id)}
                onBack={() => updateUrl({ [InboxQueryKey.Thread]: null })}
                onBookmark={() => toggleBookmark(selected.id)}
                onSessionComment={(body) => appendReply(selected.id, body)}
                thread={selected}
                view={view}
              />
            ) : (
              <InboxEmpty view={view} />
            )}
          </section>
        </div>
      </div>
    </PageChrome>
  );
}

function ThreadRow({
  archived,
  bookmarked,
  onArchive,
  onBookmark,
  onRead,
  onReply,
  onResolve,
  onSelect,
  selected,
  thread,
  view,
}: {
  archived: boolean;
  bookmarked: boolean;
  onArchive: () => void;
  onBookmark: () => void;
  onRead: () => void;
  onReply: (body: string) => void;
  onResolve: () => void;
  onSelect: () => void;
  selected: boolean;
  thread: Thread;
  view: InboxView;
}) {
  const ArtifactIcon = artifactIcons[thread.artifactType];
  const primaryMessage = getPrimaryThreadMessage(thread, selected);
  const visibleReplies = selected ? thread.replies : [];
  return (
    <article
      className={cn(
        "group relative mx-2 my-2 overflow-hidden rounded-lg border bg-card transition-colors",
        selected && "border-primary/40 bg-accent shadow-xs",
        thread.unread &&
          "before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-primary"
      )}
      data-thread-id={thread.id}
      data-unread={thread.unread ? "true" : "false"}
    >
      <button
        aria-label={`Open comment by ${thread.author} on ${thread.artifactId}`}
        className={cn(
          "w-full px-3 py-3 text-left focus-visible:ring-inset",
          CHIP_FOCUS_RING_CLASS
        )}
        onClick={onSelect}
        type="button"
      >
        <span className="flex min-w-0 items-center gap-1.5 border-b pb-2 text-muted-foreground text-xs">
          <ArtifactIcon className="size-3.5 shrink-0" />
          <span className="truncate">
            <strong className="font-medium text-foreground">
              {thread.artifactId}
            </strong>{" "}
            · {thread.artifactTitle}
          </span>
        </span>
        <span className="mt-3 flex items-start gap-2.5">
          <span className="relative shrink-0">
            <Avatar className="size-8">
              <AvatarFallback className="text-xs">
                {avatarInitial(primaryMessage.initials)}
              </AvatarFallback>
            </Avatar>
            {thread.unread ? (
              <span
                aria-hidden="true"
                className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full border-2 border-background bg-primary"
              />
            ) : null}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-start justify-between gap-2">
              <strong className="truncate text-sm">
                {primaryMessage.author}
              </strong>
              <span className="shrink-0 text-muted-foreground text-xs">
                {primaryMessage.time}
              </span>
            </span>
            <span className="mt-1 line-clamp-3 block text-sm leading-5">
              {primaryMessage.body}
            </span>
          </span>
        </span>
        {visibleReplies.length ? (
          <span className="mt-3 block space-y-2 border-t pt-3">
            {visibleReplies.map((message) => (
              <span
                className="flex items-start gap-2.5"
                key={`${message.author}-${message.time}-${message.body}`}
              >
                <Avatar className="size-7 shrink-0">
                  <AvatarFallback className="text-[10px]">
                    {avatarInitial(message.initials)}
                  </AvatarFallback>
                </Avatar>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 text-sm">
                    <strong>{message.author}</strong>
                    <span className="text-muted-foreground text-xs">
                      {message.time}
                    </span>
                  </span>
                  <span className="mt-0.5 line-clamp-2 block text-sm leading-5">
                    {message.body}
                  </span>
                </span>
              </span>
            ))}
          </span>
        ) : null}
        <span className="mt-3 flex flex-wrap items-center gap-1 border-t pt-2">
          {thread.reasons.map((reason) => (
            <Badge
              key={reason}
              variant={reason === Reason.Mention ? "info" : "secondary"}
            >
              {reason}
            </Badge>
          ))}
          {thread.replies.length ? (
            <Badge variant="secondary">
              {thread.replies.length}{" "}
              {thread.replies.length === 1 ? "reply" : "replies"}
            </Badge>
          ) : null}
          <span className="min-w-0 flex-1 truncate text-right text-muted-foreground text-xs">
            {thread.anchorDetail}
          </span>
        </span>
      </button>
      <div className="absolute top-10 right-2 hidden items-center rounded-md border bg-background p-0.5 shadow-sm group-focus-within:flex group-hover:flex">
        <RowAction
          label={thread.resolved ? "Reopen comment" : "Resolve comment"}
          onClick={onResolve}
        >
          <CheckIcon />
        </RowAction>
        <RowAction
          label={thread.unread ? "Mark read" : "Mark unread"}
          onClick={onRead}
        >
          {thread.unread ? <MailOpenIcon /> : <MailIcon />}
        </RowAction>
        <RowAction
          label={bookmarked ? "Remove bookmark" : "Bookmark"}
          onClick={onBookmark}
        >
          <BookmarkIcon className={bookmarked ? "fill-current" : undefined} />
        </RowAction>
        <RowAction
          label={
            archived || view === InboxView.Archive
              ? "Restore notification"
              : "Archive notification"
          }
          onClick={onArchive}
        >
          {archived || view === InboxView.Archive ? (
            <RotateCcwIcon />
          ) : (
            <ArchiveIcon />
          )}
        </RowAction>
      </div>
      {selected ? (
        <ThreadComposer
          onReply={onReply}
          onResolve={onResolve}
          resolved={thread.resolved}
        />
      ) : null}
    </article>
  );
}

function ThreadComposer({
  onReply,
  onResolve,
  resolved,
}: {
  onReply: (body: string) => void;
  onResolve: () => void;
  resolved: boolean;
}) {
  const [reply, setReply] = useState("");
  if (resolved) {
    return (
      <div className="flex items-center justify-between gap-2 border-t p-3 text-muted-foreground text-sm">
        <span>Resolved · no longer blocks inbox zero.</span>
        <Button onClick={onResolve} size="sm" variant="outline">
          Reopen
        </Button>
      </div>
    );
  }
  return (
    <div className="border-t p-3">
      <Textarea
        className="min-h-16 resize-none"
        onChange={(event) => setReply(event.target.value)}
        placeholder="Reply or add others with @"
        value={reply}
      />
      <div className="mt-2 flex items-center justify-between">
        <Button onClick={onResolve} size="sm" variant="ghost">
          <CheckIcon /> Resolve
        </Button>
        <Button
          disabled={!reply.trim()}
          onClick={() => {
            onReply(reply.trim());
            setReply("");
          }}
          size="sm"
        >
          Reply
        </Button>
      </div>
    </div>
  );
}
