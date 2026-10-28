"use client";

import { ArtifactCommentsToggle } from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-comments-toggle";
import {
  GenericArtifactDetailShell,
  GenericArtifactListShell,
} from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-shells";
import type { DetailTab } from "@repo/app/shared/components/generic-artifact-surface/preview/components/generic-artifact-detail-shell";
import {
  type GenericArtifact,
  genericArtifacts,
} from "@repo/app/shared/components/generic-artifact-surface/preview/fixtures";
import { Button } from "@repo/design-system/components/ui/button";
import { PlusIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import {
  buildArtifactRouteHref,
  clearArtifactRouteState,
  readArtifactRouteState,
  writeArtifactRouteState,
} from "../components/artifact-route-state";
import { PageChrome } from "../components/page-chrome";

const BASE_PATH = "/p/web-master/generic-artifact";

export const WebMasterGenericArtifactRoute = () => {
  const [artifacts, setArtifacts] =
    useState<readonly GenericArtifact[]>(genericArtifacts);
  const [selected, setSelected] = useState<GenericArtifact | null>(null);
  const [addArtifactOpen, setAddArtifactOpen] = useState(false);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [activeDetailTab, setActiveDetailTab] = useState<DetailTab>("artifact");
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null);
  const [initialTraceJumpRequest, setInitialTraceJumpRequest] = useState<{
    nonce: number;
    row: number;
  } | null>(null);
  useEffect(() => {
    const restoreRoute = () => {
      const route = readArtifactRouteState(undefined, { basePath: BASE_PATH });
      const artifact = route.artifactId
        ? genericArtifacts.find(
            (item) =>
              item.id === route.artifactId || item.slug === route.artifactId
          )
        : null;
      setSelected(artifact ?? null);
      setAddArtifactOpen(route.createOpen);
      setActiveDetailTab(route.tab ?? "artifact");
      setCommentsOpen(route.commentsOpen);
      setSelectedVersion(route.version);
      if (route.traceRow != null) {
        setInitialTraceJumpRequest({ nonce: Date.now(), row: route.traceRow });
      }
      if (
        artifact &&
        new URLSearchParams(globalThis.window.location.search).has("artifact")
      ) {
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
            basePath: BASE_PATH,
            routeKey: artifact.slug,
          }
        );
      }
    };
    restoreRoute();
    globalThis.window.addEventListener("popstate", restoreRoute);
    return () =>
      globalThis.window.removeEventListener("popstate", restoreRoute);
  }, []);
  const openDetail = (artifact: GenericArtifact) => {
    setActiveDetailTab("artifact");
    setCommentsOpen(false);
    setSelected(artifact);
    writeArtifactRouteState(
      {
        artifactId: artifact.id,
        commentId: null,
        commentsOpen: false,
        tab: "artifact",
        traceRow: null,
      },
      "push",
      { basePath: BASE_PATH, routeKey: artifact.slug }
    );
  };
  const handleArtifactsChange = useCallback(
    (next: readonly GenericArtifact[]) => {
      setArtifacts(next);
      setSelected((current) =>
        current
          ? (next.find((artifact) => artifact.id === current.id) ?? current)
          : current
      );
    },
    []
  );
  const handleAddArtifactOpenChange = (open: boolean) => {
    setAddArtifactOpen(open);
    writeArtifactRouteState({ createOpen: open }, "push");
  };
  let pageActions: ReactNode = (
    <Button onClick={() => handleAddArtifactOpenChange(true)} size="sm">
      <PlusIcon />
      Add artifact
    </Button>
  );
  if (selected) {
    pageActions =
      activeDetailTab === "details" ? null : (
        <ArtifactCommentsToggle
          onToggle={() =>
            setCommentsOpen((open) => {
              writeArtifactRouteState({ commentsOpen: !open }, "push");
              return !open;
            })
          }
          open={commentsOpen}
        />
      );
  }

  return (
    <PageChrome
      actions={pageActions}
      breadcrumbs={
        selected
          ? [
              {
                label: "Generic Artifact",
                onSelect: () => {
                  setSelected(null);
                  clearArtifactRouteState("push", { basePath: BASE_PATH });
                },
              },
              {
                editableLabel: selected.title,
                isCurrent: true,
                label: `${selected.slug} ${selected.title}`,
                onLabelChange: (title: string) => {
                  handleArtifactsChange(
                    artifacts.map((artifact) =>
                      artifact.id === selected.id
                        ? { ...artifact, title }
                        : artifact
                    )
                  );
                },
                prefix: selected.slug,
              },
            ]
          : [{ label: "Generic Artifact", isCurrent: true }]
      }
    >
      <div className={selected ? "hidden" : "contents"}>
        <GenericArtifactListShell
          addArtifactOpen={addArtifactOpen}
          artifacts={artifacts}
          onAddArtifactOpenChange={handleAddArtifactOpenChange}
          onArtifactsChange={handleArtifactsChange}
          onOpenArtifact={openDetail}
          onOpenArtifactHref={(artifact) =>
            buildArtifactRouteHref({
              artifactId: artifact.id,
              basePath: BASE_PATH,
              routeKey: artifact.slug,
              tab: "artifact",
            })
          }
          showAddArtifactButton={false}
          showBoardAddButton
        />
      </div>
      {selected ? (
        <GenericArtifactDetailShell
          artifact={selected}
          commentsOpen={commentsOpen}
          initialTab={activeDetailTab}
          initialTraceJumpRequest={initialTraceJumpRequest}
          initialVersion={selectedVersion}
          onActiveTabChange={(tab) => {
            setActiveDetailTab(tab);
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
          onSelectArtifactComment={(comment) =>
            writeArtifactRouteState(
              { commentId: comment.id, commentsOpen: true },
              "push"
            )
          }
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
        />
      ) : null}
    </PageChrome>
  );
};
