"use client";
import { toast } from "@repo/design-system/components/ui/sonner";
import {
  type TableCustomFieldDefinition as CustomFieldDefinition,
  TableAddFieldDialog,
  type TableCustomFieldReferenceSource,
} from "@repo/design-system/components/ui/table-add-field-dialog";
import { TableSelectionAnnouncer } from "@repo/design-system/components/ui/table-bulk-action-bar";
import { useIsomorphicLayoutEffect } from "@repo/design-system/hooks/use-isomorphic-layout-effect";
import type { CountNoun } from "@repo/design-system/lib/count-noun";
import type { GridTableV2LeadContext } from "@repo/design-system/lib/grid-table-v2-types";
import { cn } from "@repo/design-system/lib/utils";
import { Layers2Icon } from "lucide-react";
import { type ReactNode, type Ref, useRef } from "react";
import type { ListToolbarSearchControl } from "../../../list-toolbar-search";
import type { ArtifactStatus, GenericArtifact } from "../fixtures";
import { buildCreatedArtifact } from "./artifact-creation";
import { AddArtifactDialog } from "./artifact-creation-dialog";
import type { ArtifactHierarchyDropPlacement } from "./artifact-hierarchy";
import { ArtifactTypeIcons } from "./artifact-icons";
import { clearSelection } from "./artifact-list-bulk-actions";
import { ArtifactTablePagination } from "./artifact-list-cells";
import { ArtifactBulkActionBar } from "./artifact-list-control-adapters";
import type { useGenericArtifactListController } from "./artifact-list-shell-controller";
import {
  ArtifactListResults,
  ArtifactListToolbar,
} from "./artifact-list-shell-sections";

export function ArtifactListShellContent(
  props: ArtifactListShellController & { host?: ArtifactListHostRendering }
) {
  const {
    addArtifactOpen,
    addFieldOpen,
    applyBulkAction,
    applyBulkStatus,
    artifacts,
    boardCreationStatus,
    bulkStatusOptions,
    clampedPage,
    creationConfig,
    customFields,
    groupBy,
    moveSelectionToProject,
    onArtifactsChange,
    onOpenArtifact,
    openCreatedArtifactAfterCreate,
    pageSize,
    pageStart,
    pagedArtifacts,
    projectMove,
    selectedArtifactIds,
    selectionAnchorId,
    selectionNoun,
    setAddArtifactOpen,
    setAddFieldOpen,
    setArtifacts,
    setArtifactsState,
    setBoardCreationStatus,
    setColumnOrder,
    setCustomFields,
    setPage,
    setPageSize,
    setSelectedArtifactIds,
    setVisibleColumnIds,
    sortedArtifacts,
    tagDefinitions,
    totalPages,
    variant,
  } = props;
  const reconcileSelection = useRef(props.reconcileSelection);
  reconcileSelection.current = props.reconcileSelection;
  const unmountedVisibleArtifacts = resolveUnmountedVisibleArtifacts(props);
  useIsomorphicLayoutEffect(() => {
    if (unmountedVisibleArtifacts !== undefined) {
      reconcileSelection.current(unmountedVisibleArtifacts);
    }
  }, [unmountedVisibleArtifacts]);
  return (
    <div
      className={cn(
        "flex min-h-0 flex-1 flex-col",
        variant === "page" ? "overflow-hidden max-md:pb-14" : "overflow-visible"
      )}
    >
      <ArtifactListToolbar controller={props} />
      <TableSelectionAnnouncer
        count={selectedArtifactIds.size}
        noun={
          props.host?.bulkActionsNoun ?? {
            one: selectionNoun.singular,
            other: selectionNoun.plural,
          }
        }
      />

      <ArtifactListResults controller={props} />
      {renderArtifactHostSlot(
        props.host,
        "pagination",
        groupBy === "none" ? (
          <ArtifactTablePagination
            onPageChange={setPage}
            onPageSizeChange={(size) => {
              setPageSize(size);
              setPage(0);
            }}
            page={clampedPage}
            pageSize={pageSize}
            rangeEnd={Math.min(
              pageStart + pagedArtifacts.length,
              sortedArtifacts.length
            )}
            rangeStart={sortedArtifacts.length === 0 ? 0 : pageStart + 1}
            total={sortedArtifacts.length}
            totalPages={totalPages}
          />
        ) : null
      )}
      {/* A single selection reaches the toolbar only when the container supplies
          a valid single-item action — Move to project is the one that exists.
          Bulk-only actions still need two. */}
      {renderArtifactHostSlot(
        props.host,
        "bulkActions",
        selectedArtifactIds.size >= 2 ||
          (selectedArtifactIds.size === 1 && projectMove) ? (
          <ArtifactBulkActionBar
            count={selectedArtifactIds.size}
            currentTags={tagDefinitions}
            noun={selectionNoun}
            onAction={applyBulkAction}
            onClear={() =>
              clearSelection(setSelectedArtifactIds, selectionAnchorId)
            }
            onProjectMove={projectMove ? moveSelectionToProject : undefined}
            onStatusChange={applyBulkStatus}
            projectMoveDestinations={projectMove?.destinations}
            statusOptions={bulkStatusOptions}
          />
        ) : null
      )}
      {props.host && "creation" in props.host ? (
        props.host.creation
      ) : (
        <>
          <TableAddFieldDialog
            onCreate={(draft) => {
              const field: CustomFieldDefinition = {
                ...draft,
                id: `custom-${globalThis.crypto.randomUUID()}`,
              };
              setCustomFields((current) => [...current, field]);
              setColumnOrder((current) => [...current, field.id]);
              setVisibleColumnIds((current) => new Set(current).add(field.id));
            }}
            onOpenChange={setAddFieldOpen}
            open={addFieldOpen}
            referenceSources={GENERIC_ARTIFACT_REFERENCE_SOURCES}
          />
          <AddArtifactDialog
            artifacts={artifacts}
            config={creationConfig}
            customFields={customFields}
            initialStatus={boardCreationStatus}
            onCreate={(values, options) => {
              const previousArtifacts = artifacts;
              const createdArtifact = buildCreatedArtifact({
                config: creationConfig,
                nextNumber: artifacts.length + 1,
                values,
              });
              const nextArtifact = createdArtifact;
              setArtifacts((current) => [nextArtifact, ...current]);
              setPage(0);
              if (
                openCreatedArtifactAfterCreate &&
                options?.openAfterCreate !== false
              ) {
                onOpenArtifact(nextArtifact);
              }
              toast.success(
                options?.draft
                  ? `${nextArtifact.slug} saved as draft`
                  : `${nextArtifact.slug} created`,
                {
                  action: {
                    label: "Undo",
                    onClick: () => {
                      setArtifactsState(previousArtifacts);
                      onArtifactsChange?.(previousArtifacts);
                    },
                  },
                }
              );
            }}
            onOpenChange={(open) => {
              setAddArtifactOpen(open);
              if (!open) {
                setBoardCreationStatus(null);
              }
            }}
            open={addArtifactOpen}
          />
        </>
      )}
    </div>
  );
}

export type ArtifactListShellController = ReturnType<
  typeof useGenericArtifactListController
>;

/** Host-owned data and actions retain the exact shared list rendering. */
export type ArtifactListHostRendering = {
  /** The page's free-text search, drawn by the toolbar the shell mounts. */
  search?: ListToolbarSearchControl;
  /**
   * A host that has decided to show the shared list toolbar hands the shell
   * the whole toolbar; omitted, the shell draws its own (ISS-13035). The flag
   * is read by the host, so the shell never learns it.
   */
  renderSharedToolbar?: (controller: ArtifactListShellController) => ReactNode;
  onHierarchyDrop?: (
    artifact: GenericArtifact,
    target: GenericArtifact,
    placement: ArtifactHierarchyDropPlacement
  ) => void;
  canHierarchyDrop?: (
    artifact: GenericArtifact,
    target: GenericArtifact,
    placement: ArtifactHierarchyDropPlacement
  ) => boolean;
  onRequestBoardCreate?: (status: ArtifactStatus) => void;
  canGroupDrop?: (
    artifact: GenericArtifact,
    primaryField: string,
    primaryValue: string,
    secondaryField?: string,
    secondaryValue?: string
  ) => boolean;
  summary?: ReactNode;
  resultsState?: ReactNode;
  resultsNotice?: ReactNode;
  pagination?: ReactNode;
  creation?: ReactNode;
  bulkActions?: ReactNode;
  /**
   * The noun the host's `bulkActions` rail counts with, so the shell's one
   * selection announcement says what the visible rail says (ISS-12640).
   */
  bulkActionsNoun?: CountNoun;
  resultsRef?: Ref<HTMLDivElement>;
  renderCell?: (columnId: string, artifact: GenericArtifact) => ReactNode;
  renderBoardTitle?: (artifact: GenericArtifact, href: string) => ReactNode;
  renderBoardStatusMenu?: (artifact: GenericArtifact) => ReactNode;
  renderLead?: (
    artifact: GenericArtifact,
    context: GridTableV2LeadContext
  ) => ReactNode;
};

export function renderArtifactHostSlot(
  host: ArtifactListHostRendering | undefined,
  slot: "pagination" | "bulkActions" | "summary",
  fallback: ReactNode
): ReactNode {
  if (host && slot in host) {
    return host[slot];
  }
  return fallback;
}

const GENERIC_ARTIFACT_REFERENCE_SOURCES: readonly TableCustomFieldReferenceSource[] =
  [
    {
      icon: ArtifactTypeIcons.Session,
      label: "Sessions",
      value: "Sessions",
    },
    { icon: ArtifactTypeIcons.Issue, label: "Issues", value: "Issues" },
    {
      icon: ArtifactTypeIcons.Branch,
      label: "Branches",
      value: "Branches",
    },
    {
      icon: ArtifactTypeIcons.Document,
      label: "Documents",
      value: "Documents",
    },
    {
      icon: ArtifactTypeIcons.Agent,
      label: "Agentic Components",
      value: "Agentic Components",
    },
    { icon: Layers2Icon, label: "Projects", value: "Projects" },
  ];

function resolveUnmountedVisibleArtifacts(
  controller: ArtifactListShellController & { host?: ArtifactListHostRendering }
): readonly GenericArtifact[] | undefined {
  if (controller.layout === "board") {
    return NO_VISIBLE_ARTIFACTS;
  }
  if (controller.host && "resultsState" in controller.host) {
    return controller.pagedArtifacts;
  }
  return undefined;
}

const NO_VISIBLE_ARTIFACTS: readonly GenericArtifact[] = [];
