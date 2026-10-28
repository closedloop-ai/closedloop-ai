"use client";

import type {
  ArtifactDetailsPresentation,
  GenericCommentRecord,
} from "@repo/app/shared/components/generic-artifact-surface/preview/components/generic-artifact-detail-shell";
import {
  type ArtifactSessionTrace,
  type GenericArtifact,
  genericArtifactSessionTrace,
} from "@repo/app/shared/components/generic-artifact-surface/preview/fixtures";
import { Button } from "@repo/design-system/components/ui/button";
import { RichTextEditor, type TiptapEditor } from "@repo/rich-text";
import { RichTextToolbar } from "@repo/rich-text/rich-text-toolbar";
import { MessageSquarePlusIcon } from "lucide-react";
import { useEffect, useState } from "react";
import {
  formatDuration,
  HARNESS_CONFIG,
  sessionRows,
} from "../../../../../agents/components/sessions/web-master-legacy-preview/mock"; // Cross-slice: preview shell hosts the Sessions preview (ISS-12938).
import { ArtifactTypeIcons } from "../shared/artifact-icons";
import {
  agentContributionTrace,
  agentDetails,
} from "./agent-artifact-specialization";
import { issueV2Comments } from "./issue-v2-artifact-specialization";
import {
  prototypeContributionTrace,
  prototypeDetails,
} from "./prototype-artifact-specialization";
import { sessionCostValues } from "./specialized-artifact-fixtures";
import {
  type SpecializedArtifactKind,
  typeConfig,
} from "./specialized-artifact-kinds";

export function detailSpecializationForKind(
  kind: SpecializedArtifactKind,
  artifact: GenericArtifact
) {
  if (kind === "agents") {
    return {
      details: agentDetails(artifact),
      sessionTrace: agentContributionTrace(artifact),
    };
  }
  if (kind === "prototypes") {
    return {
      details: prototypeDetails(artifact),
      sessionTrace: prototypeContributionTrace(artifact),
    };
  }
  if (kind === "sessions") {
    return {
      details: sessionDetails(artifact),
      sessionTrace: singleSessionTrace(artifact),
    };
  }
  if (kind === "documents") {
    return {
      details: documentDetails(artifact),
      sessionTrace: contributionTraceForKind(kind, artifact),
    };
  }
  if (kind === "issues-v2") {
    const details = issueDetails(artifact);
    return {
      details: {
        ...details,
        activity: undefined,
        fields: { currentVersion: false },
        sections: {
          ...details.sections,
          activity: false,
          versionHistory: false,
        },
        versions: undefined,
      },
      sessionTrace: contributionTraceForKind("issues", artifact),
    };
  }
  return {
    details: issueDetails(artifact),
    sessionTrace: contributionTraceForKind(kind, artifact),
  };
}

export function commentsForKind(
  kind: SpecializedArtifactKind,
  artifact: GenericArtifact
): { artifact?: readonly GenericCommentRecord[] } | undefined {
  return kind === "issues-v2"
    ? { artifact: issueV2Comments(artifact) }
    : undefined;
}

export function presentationForKind(kind: SpecializedArtifactKind) {
  if (kind === "prototypes") {
    return {
      canvas: {
        frame: "flush" as const,
      },
    };
  }
  if (kind !== "issues-v2") {
    return undefined;
  }
  return {
    comments: {
      artifactPlaceholder: "Add an issue comment and @mention someone…",
      artifactTitle: "Issue comments",
    },
  };
}

export function DocumentArtifactCanvas({
  artifact,
  onAddInlineComment,
  onSelectInlineComment,
  selectionRequest,
}: {
  artifact: GenericArtifact;
  onAddInlineComment: (request: {
    anchorPreview: string;
    commentId: string;
  }) => void;
  onSelectInlineComment: (commentId: string) => void;
  selectionRequest: { commentId: string; nonce: number } | null;
}) {
  const [document, setDocument] = useState(() => documentMarkdown(artifact));
  const [editor, setEditor] = useState<TiptapEditor | null>(null);
  const [hasTextSelection, setHasTextSelection] = useState(false);
  useEffect(() => {
    if (!editor) {
      setHasTextSelection(false);
      return;
    }
    const syncSelection = () => {
      const { from, to } = editor.state.selection;
      setHasTextSelection(from !== to);
    };
    syncSelection();
    editor.on("selectionUpdate", syncSelection);
    return () => {
      editor.off("selectionUpdate", syncSelection);
    };
  }, [editor]);
  useEffect(() => {
    if (!(editor && selectionRequest)) {
      return;
    }
    for (const anchor of editor.view.dom.querySelectorAll<HTMLAnchorElement>(
      'a[rel="comment"]'
    )) {
      anchor.removeAttribute("data-scroll-highlight");
    }
    const anchor = editor.view.dom.querySelector<HTMLAnchorElement>(
      `a[href="#${selectionRequest.commentId}"]`
    );
    if (!anchor) {
      return;
    }
    anchor.setAttribute("data-scroll-highlight", "true");
    anchor.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [editor, selectionRequest]);
  const addInlineComment = () => {
    if (!editor) {
      return;
    }
    const { from, to } = editor.state.selection;
    if (from === to) {
      return;
    }
    const anchorPreview = editor.state.doc.textBetween(from, to, " ").trim();
    if (!anchorPreview) {
      return;
    }
    const commentId = `document-comment-${Date.now()}`;
    editor
      .chain()
      .focus()
      .setTextSelection({ from, to })
      .setLink({ href: `#${commentId}`, rel: "comment", target: "_self" })
      .run();
    onAddInlineComment({ anchorPreview, commentId });
  };
  return (
    <div className="flex size-full flex-col overflow-hidden">
      <div className="flex items-center border-b bg-background">
        <RichTextToolbar
          className="min-w-0 flex-1 justify-start border-b-0"
          editor={editor}
          onPasteMarkdown={(markdown) => editor?.resetContent(markdown)}
        />
        <Button
          className="mr-2 shrink-0"
          disabled={!hasTextSelection}
          onClick={addInlineComment}
          size="sm"
          type="button"
          variant="ghost"
        >
          <MessageSquarePlusIcon />
          Add comment
        </Button>
      </div>
      <div
        className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col overflow-hidden"
        onClickCapture={(event) => {
          if (!(event.target instanceof Element)) {
            return;
          }
          const anchor = event.target.closest<HTMLAnchorElement>(
            'a[href^="#document-comment-"]'
          );
          if (!anchor) {
            return;
          }
          event.preventDefault();
          onSelectInlineComment(anchor.hash.slice(1));
        }}
      >
        <RichTextEditor
          className="px-8 py-8 sm:px-12"
          externalToolbar
          onChange={setDocument}
          onEditorReady={setEditor}
          placeholder="Start writing…"
          scrollMode="inner"
          value={document}
        />
      </div>
    </div>
  );
}

function documentMarkdown(artifact: GenericArtifact): string {
  return `# ${artifact.title}

${artifact.summary}

## Problem and opportunity

Teams need one predictable artifact grammar without flattening the content that makes each document useful.

## Goals and non-goals

Standardize the shell, metadata, collaboration, and session history. Keep the document body flexible for its authoring workflow.

## Requirements

${artifact.title} remains the artifact-specific canvas while the shared shell supplies navigation, collaboration, and lifecycle behavior.

- Support structured requirements and acceptance criteria.
- Preserve inline comments and version context.
- Expose linked artifacts without duplicating metadata.`;
}

export function SpecializedArtifactCanvas({
  artifact,
  kind,
}: {
  artifact: GenericArtifact;
  kind: SpecializedArtifactKind;
}) {
  const config = typeConfig[kind];
  const content = artifactCanvasContent(kind);
  const isIssue = kind === "issues";
  return (
    <div className="mx-auto size-full max-w-5xl overflow-auto px-8 py-8">
      <div className="border-b pb-6">
        <p className="font-medium text-muted-foreground text-xs uppercase tracking-[0.12em]">
          {config.singular} view
        </p>
        <h1 className="mt-2 font-semibold text-2xl tracking-tight">
          {artifact.title}
        </h1>
        {artifact.summary ? (
          <p className="mt-2 max-w-3xl whitespace-pre-wrap text-muted-foreground text-sm leading-6">
            {artifact.summary}
          </p>
        ) : null}
      </div>
      {isIssue ? null : (
        <div className="grid gap-8 py-8 lg:grid-cols-[minmax(0,1fr)_15rem]">
          <div className="space-y-8">
            {content.sections.map((section) => (
              <section key={section.title}>
                <h2 className="font-semibold text-base">{section.title}</h2>
                <p className="mt-2 text-muted-foreground text-sm leading-6">
                  {section.body}
                </p>
                {section.items ? (
                  <ul className="mt-3 space-y-2 text-sm">
                    {section.items.map((item) => (
                      <li className="flex gap-2" key={item}>
                        <span className="mt-2 size-1 shrink-0 rounded-full bg-muted-foreground" />
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </section>
            ))}
          </div>
          <aside className="h-fit rounded-md border bg-muted/20 p-4">
            <p className="font-medium text-sm">{content.asideTitle}</p>
            <dl className="mt-4 space-y-3 text-sm">
              {content.aside.map(([label, value]) => (
                <div key={label}>
                  <dt className="text-muted-foreground text-xs">{label}</dt>
                  <dd className="mt-0.5">{value}</dd>
                </div>
              ))}
            </dl>
          </aside>
        </div>
      )}
    </div>
  );
}

type ArtifactCanvasContent = {
  sections: readonly {
    title: string;
    body: string;
    items?: readonly string[];
  }[];
  asideTitle: string;
  aside: readonly (readonly [string, string])[];
};

function artifactCanvasContent(
  kind: SpecializedArtifactKind
): ArtifactCanvasContent {
  if (kind === "agents") {
    return {
      sections: [
        {
          title: "Agent instructions",
          body: "Review artifact implementations for consistency, interaction quality, and safe reuse of shared components.",
        },
        {
          title: "Tools and permissions",
          body: "The production agent canvas can expose its tool set, model configuration, runtime policy, and evaluation history.",
          items: [
            "Read repository and design-system context.",
            "Run bounded validation and visual review.",
            "Escalate mutations that require additional authority.",
          ],
        },
      ],
      asideTitle: "Runtime",
      aside: [
        ["Harness", "Codex"],
        ["Model", "gpt-5.5"],
        ["Autonomy", "High"],
      ],
    };
  }
  return {
    sections: [
      {
        title: "Primary flow",
        body: "Demonstrate how a specialized artifact can inherit the shared list, detail, comments, and session architecture.",
      },
      {
        title: "Component states",
        body: "The prototype canvas records the important interaction and responsive states that should be validated before production implementation.",
        items: [
          "Default, hover, focus, loading, empty, and error states.",
          "Desktop, narrow desktop, and mobile behavior.",
          "Artifact-specific strings and icons remain overridable.",
        ],
      },
      {
        title: "Design notes",
        body: "This surface is intentionally specialized; the surrounding shell remains the reusable contract.",
      },
    ],
    asideTitle: "Prototype summary",
    aside: [
      ["Preview", "Available"],
      ["Branch", "prototype/generic-artifact"],
      ["Viewport", "Responsive"],
    ],
  };
}

function documentDetails(
  artifact: GenericArtifact
): ArtifactDetailsPresentation {
  const isPrd = artifact.slug === "DOC-184";
  return {
    additionalRows: [
      {
        id: "document-type",
        label: "Document type",
        editableValue: isPrd ? "PRD" : "Product brief",
        value: isPrd ? "PRD" : "Product brief",
      },
      {
        id: "audience",
        label: "Audience",
        editableValue: "Product and engineering",
        value: "Product and engineering",
      },
      {
        id: "approval",
        label: "Approval",
        editableValue: artifact.status,
        value: artifact.status,
      },
    ],
    linkedArtifacts: [
      {
        icon: ArtifactTypeIcons.Issue,
        name: "Unified artifact experience",
        relationship: "Specified by",
        slug: "FEA-2481",
        type: "Issue",
      },
      {
        icon: ArtifactTypeIcons.Branch,
        name: "prototype/generic-artifacts-web-master",
        relationship: "Implemented by",
        slug: "BR-2048",
        type: "Branch",
      },
    ],
    versions: buildVersions(artifact, 4),
    activity: buildArtifactActivity(artifact, "document"),
  };
}

function issueDetails(artifact: GenericArtifact): ArtifactDetailsPresentation {
  return {
    additionalRows: [
      {
        id: "priority",
        label: "Priority",
        editableValue: artifact.slug === "FEA-2481" ? "P0" : "P1",
        value: artifact.slug === "FEA-2481" ? "P0" : "P1",
      },
      {
        id: "sprint",
        label: "Sprint",
        editableValue: "Ottilie August Strategic Projects",
        value: "Ottilie August Strategic Projects",
      },
      {
        id: "estimate",
        label: "Estimate",
        editableValue: "8 points",
        value: "8 points",
      },
      {
        id: "dependencies",
        label: "Dependencies",
        editableValue: "2 linked artifacts",
        value: "2 linked artifacts",
      },
    ],
    linkedArtifacts: [
      {
        icon: ArtifactTypeIcons.Document,
        name: "Artifact interaction principles",
        relationship: "Defined by",
        slug: "DOC-184",
        type: "Document",
      },
      {
        icon: ArtifactTypeIcons.Branch,
        name: "Generic artifact implementation",
        relationship: "Delivered by",
        slug: "BR-2048",
        type: "Branch",
      },
    ],
    versions: buildVersions(artifact, 3),
    activity: buildArtifactActivity(artifact, "issue"),
  };
}

function buildVersions(
  artifact: GenericArtifact,
  count: number
): NonNullable<ArtifactDetailsPresentation["versions"]> {
  return Array.from({ length: count }, (_, index) => ({
    author:
      artifact.collaborators[index % artifact.collaborators.length] ??
      artifact.owner,
    id:
      index === 0
        ? artifact.currentVersion
        : String(Math.max(1, count - index)),
    state: index === 0 ? "Current" : "Superseded",
    updated: index === 0 ? artifact.updated : `${index + 1}w ago`,
  }));
}

function buildArtifactActivity(
  artifact: GenericArtifact,
  noun: "document" | "issue"
): NonNullable<ArtifactDetailsPresentation["activity"]> {
  return [
    {
      actor: artifact.owner,
      body: <>{`published ${noun} version ${artifact.currentVersion}.`}</>,
      date: artifact.updated,
      id: `${artifact.id}-published`,
      kind: "event",
      version: artifact.currentVersion,
    },
    {
      actor: artifact.collaborators[0] ?? artifact.owner,
      body: <>commented on the acceptance criteria.</>,
      date: "2d ago",
      id: `${artifact.id}-commented`,
      kind: "comment",
      version: artifact.currentVersion,
    },
  ];
}

function contributionTraceForKind(
  kind: "documents" | "issues",
  artifact: GenericArtifact
): ArtifactSessionTrace {
  const noun = kind === "documents" ? "document" : "issue";
  return {
    ...genericArtifactSessionTrace,
    sessions: genericArtifactSessionTrace.sessions
      .slice(0, 3)
      .map((session, index) => ({
        ...session,
        id: `${artifact.id}-${noun}-contribution-${index + 1}`,
        title:
          [
            `Draft ${artifact.title}`,
            `Address ${noun} review comments`,
            `Publish ${artifact.currentVersion}`,
          ][index] ?? session.title,
        prompt:
          [
            `Create the first reviewable version of this ${noun}.`,
            `Apply comments that changed this ${noun}'s content.`,
            `Validate and publish the current ${noun} version.`,
          ][index] ?? session.prompt,
      })),
  };
}

function singleSessionTrace(artifact: GenericArtifact): ArtifactSessionTrace {
  const row = sessionRows.find((session) => session.id === artifact.id);
  const source = genericArtifactSessionTrace.sessions[0];
  if (!(row && source)) {
    return genericArtifactSessionTrace;
  }
  const startMinutes = 9 * 60 + 10;
  const durationMinutes = Math.max(1, Math.round(row.durationMs / 60_000));
  const costs = sessionCostValues(row);
  const phase = (
    id: string,
    label: string,
    share: number,
    color: "primary" | "info" | "warning" | "success"
  ) => ({
    color,
    cost: Math.round(costs.total * share * 100) / 100,
    duration: formatDuration(Math.max(60_000, row.durationMs * share)),
    id,
    label,
  });
  return {
    endAt: formatClock(startMinutes + durationMinutes),
    startAt: formatClock(startMinutes),
    startDate: "2026-08-11",
    wallClock: formatDuration(row.durationMs),
    sessions: [
      {
        ...source,
        contributor: row.user?.name ?? artifact.owner,
        contributorInitials: row.user?.initials ?? artifact.ownerInitials,
        duration: formatDuration(row.durationMs),
        id: artifact.id,
        model: row.model ?? "Unknown model",
        outcome: `${row.status} after ${formatDuration(row.durationMs)} with $${costs.total.toFixed(2)} total estimated cost.`,
        phases: [
          phase("plan", "Plan", 0.18, "info"),
          phase("execute", "Execute", 0.67, "primary"),
          phase("validate", "Validate", 0.15, "success"),
        ],
        prompt: artifact.summary,
        startedAt: formatClock(startMinutes),
        title: artifact.title,
      },
    ],
  };
}

function sessionDetails(
  artifact: GenericArtifact
): ArtifactDetailsPresentation | undefined {
  const row = sessionRows.find((session) => session.id === artifact.id);
  if (!row) {
    return undefined;
  }
  return {
    additionalRows: [
      {
        id: "harness",
        label: "Harness",
        value: HARNESS_CONFIG[row.harness].label,
      },
      {
        id: "model",
        label: "Model",
        value: row.model ?? "Not recorded",
      },
      {
        id: "duration",
        label: "Duration",
        value: formatDuration(row.durationMs),
      },
      {
        id: "api-cost",
        label: "API cost",
        value: `$${sessionCostValues(row).api.toFixed(2)}`,
      },
      {
        id: "estimated-subscription-cost",
        label: "Estimated subscription cost",
        value: `$${sessionCostValues(row).subscription.toFixed(2)}`,
      },
      {
        id: "total-estimated-cost",
        label: "Est. Total",
        value: `$${sessionCostValues(row).total.toFixed(2)}`,
      },
      {
        id: "working-directory",
        label: "Working directory",
        value: row.workingDir,
      },
    ],
    activity: [
      {
        actor: row.user?.name ?? artifact.owner,
        body: <>completed this session.</>,
        date: artifact.updated,
        id: `${artifact.id}-completed`,
        kind: "event",
      },
    ],
    fields: {
      currentVersion: false,
    },
    linkedArtifacts: [
      ...row.linkedIssues.map((issue) => ({
        icon: ArtifactTypeIcons.Issue,
        name: issue.title,
        relationship: "Contributed to",
        slug: issue.slug,
        type: "Issue",
      })),
      ...row.linkedAgents.map((agent, index) => ({
        icon: ArtifactTypeIcons.Agent,
        name: agent.name,
        relationship: "Used",
        slug: `AGT-${index + 1}`,
        type: "Agent",
      })),
    ],
    sections: {
      customFields: false,
      versionHistory: false,
    },
  };
}

function formatClock(totalMinutes: number): string {
  const minutesInDay = 24 * 60;
  const normalized =
    ((totalMinutes % minutesInDay) + minutesInDay) % minutesInDay;
  const hours24 = Math.floor(normalized / 60);
  const minutes = normalized % 60;
  const suffix = hours24 >= 12 ? "pm" : "am";
  const hours12 = hours24 % 12 || 12;
  return `${hours12}:${String(minutes).padStart(2, "0")}${suffix}`;
}
