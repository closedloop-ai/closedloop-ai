"use client";

import { ArtifactCommentsToggle } from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-comments-toggle";
import { GenericArtifactListShell } from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-shells";
import {
  type DetailTab,
  GenericArtifactDetailShell,
} from "@repo/app/shared/components/generic-artifact-surface/preview/components/generic-artifact-detail-shell";
import type {
  ArtifactSessionTrace,
  GenericArtifact,
} from "@repo/app/shared/components/generic-artifact-surface/preview/fixtures";
import { Button } from "@repo/design-system/components/ui/button";
import { PlusIcon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { setProjectArtifactTitle } from "../projects/project-artifacts";
import { AgentArtifactCanvas } from "./agent-artifact-specialization";
import {
  buildArtifactRouteHref,
  clearArtifactRouteState,
  readArtifactRouteState,
  writeArtifactRouteState,
} from "./artifact-route-state";
import { IssueV2ArtifactCanvas } from "./issue-v2-artifact-specialization";
import { PageChrome } from "./page-chrome";
import { PrototypeArtifactCanvas } from "./prototype-artifact-specialization";
import {
  commentsForKind,
  DocumentArtifactCanvas,
  detailSpecializationForKind,
  presentationForKind,
  SpecializedArtifactCanvas,
} from "./specialized-artifact-detail";
import { artifactsForKind } from "./specialized-artifact-fixtures";
import type { SpecializedArtifactKind } from "./specialized-artifact-kinds";
import { typeConfig } from "./specialized-artifact-kinds";
import {
  creationConfigForKind,
  listSpecializationForKind,
  routeKeyForArtifact,
  statusBoardForKind,
} from "./specialized-artifact-list-config";
import {
  findSpecializedArtifactFixture,
  resolveSpecializedArtifactForRoute,
} from "./specialized-artifact-route-resolution";

export function SpecializedArtifactPage({
  kind,
}: {
  kind: SpecializedArtifactKind;
}) {
  const config = typeConfig[kind];
  const [artifacts, setArtifacts] = useState<readonly GenericArtifact[]>(() =>
    artifactsForKind(kind)
  );
  const [selected, setSelected] = useState<GenericArtifact | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [artifactCommentSelectionRequest, setArtifactCommentSelectionRequest] =
    useState<{ commentId: string; nonce: number } | null>(null);
  const [artifactCommentDraftRequest, setArtifactCommentDraftRequest] =
    useState<{
      anchorPreview: string;
      commentId: string;
      nonce: number;
    } | null>(null);
  const [documentCommentSelectionRequest, setDocumentCommentSelectionRequest] =
    useState<{ commentId: string; nonce: number } | null>(null);
  const [activeTab, setActiveTab] = useState<DetailTab>(
    config.tabs[0] ?? "details"
  );
  const [initialTraceJumpRequest, setInitialTraceJumpRequest] = useState<{
    nonce: number;
    row: number;
  } | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null);
  const listSpecialization = listSpecializationForKind(kind);
  const basePath = `/p/web-master/${kind}`;

  useEffect(() => {
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Route restoration intentionally reconciles artifact, tab, comments, and trace state atomically.
    const restoreRoute = () => {
      const route = readArtifactRouteState(undefined, { basePath });
      setAddOpen(route.createOpen);
      const artifactId = route.artifactId;
      if (!artifactId) {
        setSelected(null);
        return;
      }
      const params = new URLSearchParams(globalThis.window.location.search);
      const artifact =
        artifacts.find(
          (candidate) =>
            candidate.id === artifactId || candidate.slug === artifactId
        ) ??
        resolveSpecializedArtifactForRoute({
          kind,
          projectId: params.get("project"),
          routeKey: artifactId,
        });
      if (!artifact) {
        return;
      }
      const title =
        kind === "sessions" ? params.get("sessionTitle")?.trim() : null;
      const legacyFirstInvocation = params.get("firstInvocation");
      const firstInvocation =
        route.traceRow ??
        (legacyFirstInvocation === null
          ? Number.NaN
          : Number(legacyFirstInvocation));
      setSelected(title ? { ...artifact, title } : artifact);
      setActiveTab(
        route.tab && config.tabs.includes(route.tab)
          ? route.tab
          : (config.tabs[0] ?? "details")
      );
      setCommentsOpen(route.commentsOpen);
      setSelectedVersion(route.version);
      if (route.commentId) {
        setArtifactCommentSelectionRequest({
          commentId: route.commentId,
          nonce: Date.now(),
        });
      }
      if (Number.isInteger(firstInvocation) && firstInvocation >= 0) {
        setInitialTraceJumpRequest({ nonce: Date.now(), row: firstInvocation });
      }
      if (params.has("artifact")) {
        writeArtifactRouteState(
          {
            artifactId: artifact.id,
            createOpen: false,
            commentId: route.commentId,
            commentsOpen: route.commentsOpen,
            tab: route.tab,
            traceRow: route.traceRow,
            version: route.version,
          },
          "replace",
          {
            basePath,
            routeKey: routeKeyForArtifact(kind, artifact),
          }
        );
      }
    };
    restoreRoute();
    globalThis.window.addEventListener("popstate", restoreRoute);
    return () =>
      globalThis.window.removeEventListener("popstate", restoreRoute);
  }, [artifacts, basePath, config.tabs, kind]);

  const handleAddOpenChange = (open: boolean) => {
    setAddOpen(open);
    writeArtifactRouteState({ createOpen: open }, "push");
  };

  if (selected) {
    const commentsAvailable = activeTab !== "details";
    const detailSpecialization = detailSpecializationForKind(kind, selected);
    const artifactPanel =
      kind === "sessions" ? null : (
        <SpecializedArtifactTabContent
          artifact={selected}
          commentsOpen={commentsOpen}
          kind={kind}
          onAddInlineComment={({ anchorPreview, commentId }) => {
            setArtifactCommentDraftRequest({
              anchorPreview,
              commentId,
              nonce: Date.now(),
            });
            setCommentsOpen(true);
            writeArtifactRouteState({ commentId, commentsOpen: true }, "push");
          }}
          onCommentsOpenChange={setCommentsOpen}
          onSelectComment={(commentId) => {
            setArtifactCommentSelectionRequest({
              commentId,
              nonce: Date.now(),
            });
            setCommentsOpen(true);
            writeArtifactRouteState({ commentId, commentsOpen: true }, "push");
          }}
          selectionRequest={documentCommentSelectionRequest}
        />
      );
    const initialComments = commentsForKind(kind, selected);
    return (
      <PageChrome
        actions={
          commentsAvailable ? (
            <ArtifactCommentsToggle
              onToggle={() =>
                setCommentsOpen((open) => {
                  writeArtifactRouteState({ commentsOpen: !open }, "push");
                  return !open;
                })
              }
              open={commentsOpen}
            />
          ) : null
        }
        breadcrumbs={[
          {
            label: config.label,
            onSelect: () => {
              setSelected(null);
              clearArtifactRouteState("push", { basePath });
            },
          },
          {
            editableLabel: selected.title,
            isCurrent: true,
            label: `${selected.slug} ${selected.title}`,
            onLabelChange:
              kind === "sessions"
                ? undefined
                : (title) => {
                    setArtifacts((current) =>
                      current.map((artifact) =>
                        artifact.id === selected.id
                          ? { ...artifact, title }
                          : artifact
                      )
                    );
                    // A project-scoped artifact is not in this collection, so the
                    // write above only changes the collection's identity, which
                    // reruns the route restore below and would load the project
                    // fixture's original title back over the rename.
                    setProjectArtifactTitle(selected, title);
                    setSelected((current) =>
                      current ? { ...current, title } : current
                    );
                  },
            prefix: selected.slug,
          },
        ]}
      >
        <GenericArtifactDetailShell
          artifact={selected}
          artifactCommentDraftRequest={artifactCommentDraftRequest}
          artifactCommentSelectionRequest={artifactCommentSelectionRequest}
          commentsOpen={commentsAvailable && commentsOpen}
          details={detailSpecialization.details}
          initialComments={initialComments}
          initialTab={activeTab}
          initialTraceJumpRequest={initialTraceJumpRequest}
          initialVersion={selectedVersion}
          onActiveTabChange={(tab) => {
            setActiveTab(tab);
            writeArtifactRouteState(
              {
                tab,
                ...(tab === "details"
                  ? { commentId: null, commentsOpen: false, traceRow: null }
                  : {}),
              },
              "push"
            );
            if (tab === "details") {
              setCommentsOpen(false);
            }
          }}
          onCommentsOpenChange={(open) => {
            setCommentsOpen(open);
            writeArtifactRouteState({ commentsOpen: open }, "push");
          }}
          onSelectArtifactComment={(comment) => {
            setDocumentCommentSelectionRequest({
              commentId: comment.id,
              nonce: Date.now(),
            });
            writeArtifactRouteState(
              { commentId: comment.id, commentsOpen: true },
              "push"
            );
          }}
          onSelectSessionComment={(commentId, traceRow) =>
            writeArtifactRouteState(
              {
                commentId,
                commentsOpen: true,
                tab: "sessions",
                traceRow,
              },
              "push"
            )
          }
          onVersionChange={(version) => {
            setSelectedVersion(version);
            writeArtifactRouteState({ version }, "push");
          }}
          panels={
            config.tabs.includes("artifact")
              ? { artifact: artifactPanel }
              : undefined
          }
          presentation={presentationForKind(kind)}
          sessionTrace={detailSpecialization.sessionTrace}
          tabs={config.tabs}
        />
      </PageChrome>
    );
  }

  return (
    <PageChrome
      actions={
        kind === "sessions" ? null : (
          <Button onClick={() => handleAddOpenChange(true)} size="sm">
            <PlusIcon />
            Add {config.singular}
          </Button>
        )
      }
      breadcrumbs={[{ label: config.label, isCurrent: true }]}
    >
      <GenericArtifactListShell
        addArtifactOpen={addOpen}
        additionalColumns={listSpecialization.columns}
        artifacts={artifacts}
        buildSummaryMetrics={listSpecialization.buildSummaryMetrics}
        creationConfig={creationConfigForKind(kind)}
        defaultVisibleColumnIds={listSpecialization.defaultVisibleColumnIds}
        excludedColumnIds={listSpecialization.excludedColumnIds}
        inlineCreate={
          kind === "issues" || kind === "issues-v2"
            ? { enabled: true, label: "Add issue" }
            : undefined
        }
        legacyColumnAliases={
          kind === "sessions"
            ? {
                cost: [
                  "autonomy",
                  "related-branches",
                  "api-cost",
                  "estimated-subscription-cost",
                  "total-estimated-cost",
                ],
              }
            : undefined
        }
        legacyMetricAliases={
          kind === "sessions"
            ? {
                "completion-rate": [],
                "median-cost": [],
                "median-duration": [],
                "total-cost": [
                  "api-cost",
                  "estimated-subscription-cost",
                  "total-estimated-cost",
                ],
              }
            : undefined
        }
        onAddArtifactOpenChange={handleAddOpenChange}
        onArtifactsChange={setArtifacts}
        onOpenArtifact={(artifact) => {
          setSelected(artifact);
          setCommentsOpen(false);
          setArtifactCommentSelectionRequest(null);
          setArtifactCommentDraftRequest(null);
          setDocumentCommentSelectionRequest(null);
          setActiveTab(config.tabs[0] ?? "details");
          writeArtifactRouteState(
            {
              artifactId: artifact.id,
              tab: config.tabs[0] ?? "details",
              commentsOpen: false,
              commentId: null,
              traceRow: null,
            },
            "push",
            { basePath, routeKey: routeKeyForArtifact(kind, artifact) }
          );
        }}
        onOpenArtifactHref={(artifact) =>
          buildArtifactRouteHref({
            artifactId: artifact.id,
            basePath,
            routeKey: routeKeyForArtifact(kind, artifact),
            tab: config.tabs[0] ?? "details",
          })
        }
        relatedSessionsForArtifact={(artifact) =>
          detailSpecializationForKind(kind, artifact).sessionTrace
        }
        selectionNoun={{
          plural: kind === "issues-v2" ? "issues" : config.label.toLowerCase(),
          singular: config.singular,
        }}
        showAddArtifactButton={false}
        showBoardAddButton={kind !== "sessions"}
        statusBoard={statusBoardForKind(kind)}
        summaryMetricDefinitions={listSpecialization.metricDefinitions}
      />
    </PageChrome>
  );
}

export function SpecializedArtifactTabContent({
  artifact,
  commentsOpen = false,
  kind,
  onAddInlineComment = () => undefined,
  onCommentsOpenChange = () => undefined,
  onSelectComment = () => undefined,
  selectionRequest = null,
}: {
  artifact: GenericArtifact;
  commentsOpen?: boolean;
  kind: Exclude<SpecializedArtifactKind, "sessions">;
  onAddInlineComment?: (request: {
    anchorPreview: string;
    commentId: string;
  }) => void;
  onCommentsOpenChange?: (open: boolean) => void;
  onSelectComment?: (commentId: string) => void;
  selectionRequest?: {
    commentId: string;
    nonce: number;
  } | null;
}): ReactNode {
  if (kind === "agents") {
    return <AgentArtifactCanvas artifact={artifact} />;
  }
  if (kind === "documents") {
    return (
      <DocumentArtifactCanvas
        artifact={artifact}
        onAddInlineComment={onAddInlineComment}
        onSelectInlineComment={onSelectComment}
        selectionRequest={selectionRequest}
      />
    );
  }
  if (kind === "issues-v2") {
    return (
      <IssueV2ArtifactCanvas
        artifact={artifact}
        onSelectComment={onSelectComment}
      />
    );
  }
  if (kind === "prototypes") {
    return (
      <PrototypeArtifactCanvas
        artifact={artifact}
        commentsOpen={commentsOpen}
        onCommentsOpenChange={onCommentsOpenChange}
      />
    );
  }
  return <SpecializedArtifactCanvas artifact={artifact} kind={kind} />;
}

export function getSpecializedArtifactFixture(
  kind: SpecializedArtifactKind,
  key: string
): GenericArtifact | undefined {
  return findSpecializedArtifactFixture(kind, key);
}

export function getSpecializedArtifactTrace(
  kind: SpecializedArtifactKind,
  artifact: GenericArtifact
): ArtifactSessionTrace {
  return detailSpecializationForKind(kind, artifact).sessionTrace;
}

export type { SpecializedArtifactKind } from "./specialized-artifact-kinds";
