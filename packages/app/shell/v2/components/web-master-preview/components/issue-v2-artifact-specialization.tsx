"use client";

import type { GenericCommentRecord } from "@repo/app/shared/components/generic-artifact-surface/preview/components/generic-artifact-detail-shell";
import type { GenericArtifact } from "@repo/app/shared/components/generic-artifact-surface/preview/fixtures";
import { Button } from "@repo/design-system/components/ui/button";
import {
  CHIP_FOCUS_RING_CLASS,
  Chip,
} from "@repo/design-system/components/ui/chip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { Input } from "@repo/design-system/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@repo/design-system/components/ui/popover";
import { toast } from "@repo/design-system/components/ui/sonner";
import { Textarea } from "@repo/design-system/components/ui/textarea";
import { cn } from "@repo/design-system/lib/utils";
import { RichTextEditor, type TiptapEditor } from "@repo/rich-text";
import { RichTextToolbar } from "@repo/rich-text/rich-text-toolbar";
import {
  ArrowUpRightIcon,
  CalendarRangeIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  CircleDotIcon,
  GitPullRequestIcon,
  ListChecksIcon,
  type LucideIcon,
  MessageSquareIcon,
  PencilIcon,
  PlusIcon,
  RocketIcon,
  SparklesIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { ArtifactTypeIcons } from "../shared/artifact-icons";

const REVIEW_COMMENT_ID = "issue-v2-review-comment";

type SubIssue = {
  assignee: string;
  description: string;
  id: string;
  priority: "High" | "Medium" | "Low";
  status: "Todo" | "In progress";
  title: string;
};

type IssueV2ArtifactCanvasProps = {
  artifact: GenericArtifact;
  onSelectComment: (commentId: string) => void;
};

export function IssueV2ArtifactCanvas({
  artifact,
  onSelectComment,
}: IssueV2ArtifactCanvasProps) {
  const [title, setTitle] = useState(artifact.title);
  const [definition, setDefinition] = useState(
    issueDefinitionForArtifact(artifact)
  );
  const [readyForReview, setReadyForReview] = useState(false);
  const [subIssueComposerOpen, setSubIssueComposerOpen] = useState(false);
  const [subIssues, setSubIssues] = useState<readonly SubIssue[]>([]);

  useEffect(() => {
    setTitle(artifact.title);
  }, [artifact.title]);

  return (
    <div className="size-full overflow-auto">
      <div className="mx-auto w-full max-w-7xl px-6 py-7 sm:px-8 sm:py-9">
        <section className="border-b pb-7">
          <div className="flex items-center gap-2 text-muted-foreground text-xs">
            <CircleDotIcon className="size-3.5" />
            <span className="font-mono">{artifact.slug}</span>
            <span aria-hidden>·</span>
            <span>Issue work definition</span>
          </div>
          <EditableIssueTitle onChange={setTitle} value={title} />
          <div className="max-w-5xl">
            <EditableIssueDefinition
              onChange={setDefinition}
              value={definition}
            />
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button
              aria-expanded={subIssueComposerOpen}
              onClick={() => setSubIssueComposerOpen(true)}
              size="sm"
              variant="outline"
            >
              <PlusIcon />
              Add sub-issue
            </Button>
            <Button
              onClick={() => toast.success("Source document opened")}
              size="sm"
              variant="ghost"
            >
              <ArtifactTypeIcons.Document />
              DOC-184 source requirements
            </Button>
          </div>
          <SubIssueSection
            onAdd={() => setSubIssueComposerOpen(true)}
            onCancel={() => setSubIssueComposerOpen(false)}
            onCreate={(subIssue) => {
              setSubIssues((current) => [...current, subIssue]);
              setSubIssueComposerOpen(false);
              toast.success(`${subIssue.id} created as a sub-issue`);
            }}
            open={subIssueComposerOpen}
            parentSlug={artifact.slug}
            subIssues={subIssues}
          />
        </section>

        <section aria-labelledby="issue-activity-title" className="pt-7">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="font-semibold text-base" id="issue-activity-title">
                Activity
              </h2>
              <p className="mt-1 text-muted-foreground text-sm">
                Planning, delivery, and lifecycle changes for this issue.
              </p>
            </div>
            <Chip variant="muted">Oldest first</Chip>
          </div>

          <ol className="relative mt-6 ml-4 border-l pl-7">
            <ActivityEvent
              actor="Ottilie Eastwick"
              date="Aug 4 · 9:12 AM"
              icon={PlusIcon}
              title="created this issue from DOC-184"
            >
              <LinkedRecord
                icon={ArtifactTypeIcons.Document}
                label="DOC-184 Artifact interaction principles"
                meta="Source requirements"
              />
            </ActivityEvent>
            <ActivityEvent
              actor="Pascoe Birchall"
              date="Aug 4 · 10:03 AM"
              icon={CalendarRangeIcon}
              title="added the issue to the August strategic sprint"
            />
            <ActivityEvent
              actor="Ottilie Eastwick"
              date="Aug 5 · 2:18 PM"
              icon={SparklesIcon}
              title="generated and approved an implementation plan"
            >
              <LinkedRecord
                actionLabel="View plan"
                icon={ListChecksIcon}
                label="PLN-903 Shared artifact list controls"
                meta="Approved · 8 implementation steps"
              />
            </ActivityEvent>
            <ActivityEvent
              actor="Ottilie Eastwick"
              date="Aug 6 · 11:41 AM"
              icon={ArtifactTypeIcons.Branch}
              title="started implementation"
            >
              <LinkedRecord
                actionLabel="Open branch"
                icon={ArtifactTypeIcons.Branch}
                label="BR-2048 prototype/generic-artifacts-web-master"
                meta="12 commits · updated 18m ago"
              />
            </ActivityEvent>
            <ActivityEvent
              actor="GitHub"
              date="Aug 10 · 4:26 PM"
              icon={GitPullRequestIcon}
              title="linked a pull request that delivers this issue"
            >
              <LinkedRecord
                actionLabel="Review pull request"
                icon={GitPullRequestIcon}
                label="#4094 Generic artifact list and detail architecture"
                meta="Open · 12/12 checks passing"
                status="In review"
              />
            </ActivityEvent>
            <ActivityEvent
              actor="Jordan Lee"
              date="Aug 11 · 8:14 AM"
              icon={MessageSquareIcon}
              title="commented on the acceptance criteria"
            >
              <button
                className="mt-3 flex w-full items-center gap-3 rounded-md border bg-muted/20 p-3 text-left transition-colors hover:bg-muted/50"
                onClick={() => onSelectComment(REVIEW_COMMENT_ID)}
                type="button"
              >
                <MessageSquareIcon className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">
                    “The acceptance criteria now make the delivery boundary
                    clear.”
                  </span>
                  <span className="mt-0.5 block text-muted-foreground text-xs">
                    Open in issue comments
                  </span>
                </span>
                <ArrowUpRightIcon className="size-4 shrink-0 text-muted-foreground" />
              </button>
            </ActivityEvent>
            <ActivityEvent
              actor="Ottilie Eastwick"
              date="Aug 11 · 10:32 AM"
              icon={CheckCircle2Icon}
              title="moved the issue to In review"
            />
            {subIssues.map((subIssue) => (
              <ActivityEvent
                actor="Ottilie Eastwick"
                date="just now"
                icon={CircleDotIcon}
                key={`activity-${subIssue.id}`}
                title="created a sub-issue"
              >
                <LinkedRecord
                  actionLabel="Open sub-issue"
                  icon={CircleDotIcon}
                  label={`${subIssue.id} ${subIssue.title}`}
                  meta={`${subIssue.status} · ${subIssue.priority} priority · ${subIssue.assignee}`}
                />
              </ActivityEvent>
            ))}
            <ActivityEvent
              actor="Workflow"
              date="Next action"
              icon={RocketIcon}
              last
              title={
                readyForReview
                  ? "review handoff is ready"
                  : "prepare the delivery for final review"
              }
            >
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-md border bg-card p-3">
                <div>
                  <p className="font-medium text-sm">
                    {readyForReview
                      ? "Reviewers were notified"
                      : "All required checks are passing"}
                  </p>
                  <p className="mt-0.5 text-muted-foreground text-xs">
                    {readyForReview
                      ? "The issue remains In review until the pull request merges."
                      : "Notify the owner and collaborators that the issue is ready."}
                  </p>
                </div>
                <Button
                  disabled={readyForReview}
                  onClick={() => {
                    setReadyForReview(true);
                    toast.success("Issue marked ready for final review");
                  }}
                  size="sm"
                >
                  <CheckCircle2Icon />
                  {readyForReview ? "Ready for review" : "Mark ready"}
                </Button>
              </div>
            </ActivityEvent>
          </ol>
        </section>
      </div>
    </div>
  );
}

function SubIssueSection({
  onAdd,
  onCancel,
  onCreate,
  open,
  parentSlug,
  subIssues,
}: {
  onAdd: () => void;
  onCancel: () => void;
  onCreate: (subIssue: SubIssue) => void;
  open: boolean;
  parentSlug: string;
  subIssues: readonly SubIssue[];
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<SubIssue["status"]>("Todo");
  const [priority, setPriority] = useState<SubIssue["priority"]>("High");
  const [assignee, setAssignee] = useState("Ottilie Eastwick");

  const reset = () => {
    setTitle("");
    setDescription("");
    setStatus("Todo");
    setPriority("High");
    setAssignee("Ottilie Eastwick");
  };
  const cancel = () => {
    reset();
    onCancel();
  };
  const create = () => {
    const nextTitle = title.trim();
    if (!nextTitle) {
      return;
    }
    onCreate({
      assignee,
      description: description.trim(),
      id: `${parentSlug}.${subIssues.length + 1}`,
      priority,
      status,
      title: nextTitle,
    });
    reset();
  };

  if (!(open || subIssues.length > 0)) {
    return null;
  }

  return (
    <div className="mt-4 max-w-5xl overflow-hidden rounded-md border bg-card">
      {subIssues.length > 0 ? (
        <div className="border-b">
          <div className="flex h-10 items-center gap-2 px-3">
            <ListChecksIcon className="size-4 text-muted-foreground" />
            <span className="font-medium text-sm">Sub-issues</span>
            <Chip variant="muted">{subIssues.length}</Chip>
          </div>
          <div className="divide-y border-t">
            {subIssues.map((subIssue) => (
              <button
                className={cn(
                  "group flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/40 focus-visible:ring-inset",
                  CHIP_FOCUS_RING_CLASS
                )}
                key={subIssue.id}
                onClick={() => toast.success(`${subIssue.id} opened`)}
                type="button"
              >
                <CircleDotIcon className="size-4 shrink-0 text-muted-foreground" />
                <span className="shrink-0 font-mono text-muted-foreground text-xs">
                  {subIssue.id}
                </span>
                <span className="min-w-0 flex-1 truncate font-medium text-sm">
                  {subIssue.title}
                </span>
                <Chip variant={subIssue.status === "Todo" ? "muted" : "info"}>
                  {subIssue.status}
                </Chip>
                <span className="hidden text-muted-foreground text-xs sm:inline">
                  {subIssue.assignee}
                </span>
                <ArrowUpRightIcon className="size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {open ? (
        <form
          aria-label="Create sub-issue"
          className="p-3"
          onSubmit={(event) => {
            event.preventDefault();
            create();
          }}
        >
          <div className="flex items-start gap-3">
            <SubIssuePropertyMenu
              label={status}
              onSelect={(value) => setStatus(value as SubIssue["status"])}
              options={["Todo", "In progress"]}
            />
            <div className="min-w-0 flex-1">
              <Input
                aria-label="Sub-issue title"
                autoFocus
                className="h-8 border-0 px-0 font-medium shadow-none focus-visible:ring-0"
                onChange={(event) => setTitle(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    (event.metaKey || event.ctrlKey)
                  ) {
                    create();
                  } else if (event.key === "Escape") {
                    cancel();
                  }
                }}
                placeholder="Issue title"
                value={title}
              />
              <Textarea
                aria-label="Sub-issue description"
                className="mt-1 min-h-20 resize-none border-0 px-0 py-1 shadow-none focus-visible:ring-0"
                onChange={(event) => setDescription(event.target.value)}
                placeholder="Add description…"
                value={description}
              />
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t pt-3">
            <SubIssuePropertyMenu
              label={priority}
              onSelect={(value) => setPriority(value as SubIssue["priority"])}
              options={["High", "Medium", "Low"]}
            />
            <SubIssuePropertyMenu
              label={assignee}
              onSelect={setAssignee}
              options={["Ottilie Eastwick", "Pascoe Birchall", "Jordan Lee"]}
            />
            <div className="ml-auto flex items-center gap-2">
              <Button onClick={cancel} size="sm" variant="ghost">
                Cancel
              </Button>
              <Button disabled={!title.trim()} size="sm" type="submit">
                Create
              </Button>
            </div>
          </div>
        </form>
      ) : (
        <button
          className="flex h-10 w-full items-center gap-2 px-3 text-muted-foreground text-sm transition-colors hover:bg-muted/40 hover:text-foreground"
          onClick={onAdd}
          type="button"
        >
          <PlusIcon className="size-4" />
          Add another sub-issue
        </button>
      )}
    </div>
  );
}

function SubIssuePropertyMenu({
  label,
  onSelect,
  options,
}: {
  label: string;
  onSelect: (value: string) => void;
  options: readonly string[];
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button className="shrink-0" size="sm" variant="outline">
          {label}
          <ChevronDownIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {options.map((option) => (
          <DropdownMenuItem key={option} onSelect={() => onSelect(option)}>
            {option}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function issueV2Comments(
  artifact: GenericArtifact
): readonly GenericCommentRecord[] {
  return [
    {
      author: "Jordan Lee",
      body: "The acceptance criteria now make the delivery boundary clear. The source PRD and implementation plan are both easy to trace from here.",
      context: `${artifact.slug} · Acceptance criteria`,
      id: REVIEW_COMMENT_ID,
      time: "18 min ago",
      anchor: { kind: "text" },
      source: { provider: "native" },
      status: "open",
    },
    {
      author: "Pascoe Birchall",
      body: "Keep the issue focused on sprint-ready delivery. Supporting reference material belongs in DOC-184.",
      context: `${artifact.slug} · Work definition`,
      id: "issue-v2-scope-comment",
      time: "8 min ago",
      anchor: { kind: "text" },
      source: { provider: "native" },
      status: "open",
    },
  ];
}

function EditableIssueTitle({
  onChange,
  value,
}: {
  onChange: (value: string) => void;
  value: string;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const save = () => {
    const next = draft.trim();
    if (next) {
      onChange(next);
      toast.success("Issue title updated");
    } else {
      setDraft(value);
    }
    setOpen(false);
  };
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <button
          className={cn(
            "group mt-3 flex max-w-full items-start gap-2 rounded-md text-left",
            CHIP_FOCUS_RING_CLASS
          )}
          type="button"
        >
          <h1 className="font-semibold text-2xl tracking-tight sm:text-3xl">
            {value}
          </h1>
          <PencilIcon className="mt-2 size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[min(34rem,calc(100vw-2rem))] p-3"
      >
        <label className="font-medium text-sm" htmlFor="issue-v2-title">
          Issue title
        </label>
        <Input
          autoFocus
          className="mt-2"
          id="issue-v2-title"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              save();
            } else if (event.key === "Escape") {
              setDraft(value);
              setOpen(false);
            }
          }}
          value={draft}
        />
        <div className="mt-3 flex justify-end gap-2">
          <Button
            onClick={() => {
              setDraft(value);
              setOpen(false);
            }}
            size="sm"
            variant="ghost"
          >
            Cancel
          </Button>
          <Button onClick={save} size="sm">
            Save
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function EditableIssueDefinition({
  onChange,
  value,
}: {
  onChange: (value: string) => void;
  value: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [editor, setEditor] = useState<TiptapEditor | null>(null);

  const cancel = () => {
    setDraft(value);
    setEditing(false);
  };

  const save = () => {
    const next = draft.trim();
    if (next) {
      onChange(next);
      toast.success("Issue description updated");
    }
    setEditing(false);
  };

  if (editing) {
    return (
      <div className="mt-5 overflow-hidden rounded-md border bg-background shadow-sm ring-1 ring-primary/20">
        <div className="flex items-center justify-between gap-3 border-b bg-muted/20 pr-3">
          <RichTextToolbar
            className="min-w-0 flex-1 justify-start border-0 bg-transparent"
            editor={editor}
            onPasteMarkdown={(markdown) => editor?.resetContent(markdown)}
          />
          <span className="shrink-0 text-muted-foreground text-xs">
            Issue description
          </span>
        </div>
        <RichTextEditor
          className="min-h-72 px-4 py-4"
          externalToolbar
          onChange={setDraft}
          onEditorReady={setEditor}
          placeholder="Describe the problem, desired outcome, and acceptance criteria…"
          scrollMode="outer"
          value={draft}
        />
        <div className="flex items-center justify-end gap-2 border-t bg-muted/10 px-3 py-2">
          <Button onClick={cancel} size="sm" variant="ghost">
            Cancel
          </Button>
          <Button onClick={save} size="sm">
            Save changes
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="group relative mt-5 w-full rounded-md border bg-muted/10 transition-colors hover:bg-muted/20">
      <Button
        aria-label="Edit issue description"
        className="absolute top-3 right-3 z-10 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
        onClick={() => {
          setDraft(value);
          setEditing(true);
        }}
        size="sm"
        variant="outline"
      >
        <PencilIcon />
        Edit
      </Button>
      <RichTextEditor
        className="px-4 py-4 pr-24"
        externalToolbar
        onChange={() => undefined}
        readOnly
        scrollMode="outer"
        value={value}
      />
    </div>
  );
}

function ActivityEvent({
  actor,
  children,
  date,
  icon: Icon,
  last = false,
  title,
}: {
  actor: string;
  children?: ReactNode;
  date: string;
  icon: LucideIcon;
  last?: boolean;
  title: string;
}) {
  return (
    <li className={cn("relative pb-7", last && "pb-0")}>
      <span className="absolute top-0 -left-[2.45rem] flex size-6 items-center justify-center rounded-full border bg-background">
        <Icon className="size-3.5 text-muted-foreground" />
      </span>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
        <span className="font-medium">{actor}</span>
        <span>{title}</span>
        <span className="text-muted-foreground text-xs">· {date}</span>
      </div>
      {children}
    </li>
  );
}

function LinkedRecord({
  actionLabel,
  icon: Icon,
  label,
  meta,
  status,
}: {
  actionLabel?: string;
  icon: LucideIcon;
  label: string;
  meta: string;
  status?: string;
}) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-3 rounded-md border bg-card p-3">
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium text-sm">{label}</span>
          {status ? <Chip variant="info">{status}</Chip> : null}
        </div>
        <p className="mt-0.5 text-muted-foreground text-xs">{meta}</p>
      </div>
      {actionLabel ? (
        <Button
          onClick={() => toast.success(`${actionLabel} opened`)}
          size="sm"
          variant="ghost"
        >
          {actionLabel}
          <ArrowUpRightIcon />
        </Button>
      ) : null}
    </div>
  );
}

function issueDefinitionForArtifact(artifact: GenericArtifact): string {
  return `## Problem\n\n${artifact.summary}\n\n## Desired outcome\n\nA sprint-ready unit of work can move from source requirements through planning, implementation, review, and delivery without losing provenance.\n\n## Acceptance criteria\n\n- The issue links back to its source document.\n- Planning and delivery events appear chronologically.\n- Comments remain in the right rail and metadata remains on Details.\n- Contributing sessions appear on Sessions.`;
}
