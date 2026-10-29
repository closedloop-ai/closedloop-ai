"use client";

import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import {
  type ArtifactBoardSelectionIntent,
  artifactBoardSelectionFromIntent,
} from "@repo/app/shared/components/generic-artifact-surface/artifact-board/artifact-board-model";
import {
  LIST_TOOLBAR_SEARCH_LABEL,
  LIST_TOOLBAR_SEARCH_PLACEHOLDER,
} from "@repo/app/shared/components/list-toolbar-copy";
import { ProductGridTableV2 as GridTable } from "@repo/app/shared/components/product-grid-table-v2";
import { useManualArtifactOrderingEnabled } from "@repo/app/shared/feature-flags/use-manual-artifact-ordering";
import { ArtifactStatusVariant } from "@repo/app/shared/lib/artifact-status-view-contract";
import { tableGroupCollapsePort } from "@repo/app/shared/lib/table-collapsed-groups";
import { ActiveFiltersBar } from "@repo/design-system/components/ui/active-filters-bar";
import { Button } from "@repo/design-system/components/ui/button";
import {
  FilterGroupContent,
  FilterPopover,
} from "@repo/design-system/components/ui/filter-popover";
import { RangeSubmenu } from "@repo/design-system/components/ui/filter-range-submenu";
import { RangeSubmenu as ForkRangeSubmenu } from "@repo/design-system/components/ui/filter-range-submenu-v2";
import { Input } from "@repo/design-system/components/ui/input";
import { MetricCard } from "@repo/design-system/components/ui/primitives/metric-card";
import { TableInlineCreateRow } from "@repo/design-system/components/ui/table-inline-create-row";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@repo/design-system/components/ui/toggle-group";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import { formatGridCardSelectionLabel } from "@repo/design-system/lib/grid-table-aria";
import { cn } from "@repo/design-system/lib/utils";
import { Columns3Icon, ListIcon, PlusIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { useFeatureFlagEnabledOptional } from "../../../../feature-flags/use-feature-flag-enabled";
import { GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY } from "../../../../lib/feature-flags";
import { genericArtifactStatusCapability } from "../../generic-artifact-status";
import { artifactDateComparisonLabel } from "./artifact-date-dimension";
import { ArtifactHierarchyControls } from "./artifact-hierarchy-controls";
import { ArtifactHierarchyLead } from "./artifact-hierarchy-row";
import { ArtifactListBoardView } from "./artifact-list-board";
import {
  EditableArtifactLead,
  GenericArtifactCardCompatibility,
  renderGenericArtifactCell,
} from "./artifact-list-cells";
import {
  ArtifactGroupMenu,
  ArtifactOptionsMenu,
  ArtifactSavedViewsMenu,
  ArtifactSortMenu,
  ArtifactViewMenu,
} from "./artifact-list-control-adapters";
import { artifactListFavorite } from "./artifact-list-favorite";
import { resolveArtifactGroupDestination } from "./artifact-list-group-drop";
import { DATE_RANGES, TagEditorContext } from "./artifact-list-model";
import { artifactRouteGrouping } from "./artifact-list-route-state";
import {
  type ArtifactListHostRendering,
  renderArtifactHostSlot,
} from "./artifact-list-shell-content";
import type { useGenericArtifactListController } from "./artifact-list-shell-controller";
import { ArtifactStatusBoard } from "./artifact-status-board";

type ArtifactListShellController = ReturnType<
  typeof useGenericArtifactListController
> & { host?: ArtifactListHostRendering };

export function ArtifactListToolbar({
  controller,
}: Readonly<{ controller: ArtifactListShellController }>) {
  const {
    activeSavedViewId,
    applySavedView,
    customFields,
    configuredColumns,
    dateDimension,
    dateFilterLabel,
    filterController,
    filterMenuOpen,
    filterViewModel,
    filtersActive,
    groupBy,
    groupOrder,
    layout,
    saveCurrentView,
    savedViews,
    secondaryGroupBy,
    secondaryGroupOrder,
    setAddArtifactOpen,
    setAddFieldOpen,
    setArtifactListLayout,
    setCustomFieldFilters,
    setExtensionFilters,
    setFilterMenuOpen,
    setGroupBy,
    setGroupOrder,
    setPage,
    setSecondaryGroupBy,
    setSecondaryGroupOrder,
    setShowEmptyGroups,
    setShowEmptySubgroups,
    setSortActive,
    setSortBy,
    setSortDir,
    setVisibleColumnIds,
    setVisibleMetricKeys,
    showAddArtifactButton,
    showAddFieldButton,
    showEmptyGroups,
    showEmptySubgroups,
    sortActive,
    sortBy,
    summaryMetricDefinitions,
    variant,
    visibleColumnIds,
    visibleMetricKeys,
  } = controller;
  // ISS-12641: closed, range facets render the fork `main` rendered before the
  // merge onto the champion.
  const championControls = useFeatureFlagEnabledOptional(
    GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY
  );
  const RangeSubmenuControl = championControls
    ? RangeSubmenu
    : ForkRangeSubmenu;
  if (controller.host?.renderSharedToolbar) {
    return controller.host.renderSharedToolbar(controller);
  }
  return (
    <div className="border-b px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        {controller.host?.search ? (
          <Input
            aria-label={LIST_TOOLBAR_SEARCH_LABEL}
            className="h-8 max-w-64"
            onChange={(event) =>
              controller.host?.search?.onChange(event.target.value)
            }
            placeholder={LIST_TOOLBAR_SEARCH_PLACEHOLDER}
            value={controller.host.search.value}
          />
        ) : null}
        {dateDimension.present ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <ToggleGroup
                aria-label={dateFilterLabel}
                onValueChange={(value) => {
                  if (value) {
                    dateDimension.setRange(value);
                    setPage(0);
                  }
                }}
                type="single"
                value={dateDimension.range}
                variant="outline"
              >
                {DATE_RANGES.map((range) => (
                  <ToggleGroupItem
                    aria-label={range.label}
                    className="px-2.5 data-[variant=outline]:h-[26px]"
                    key={range.value}
                    value={range.value}
                  >
                    {range.value === "all" ? "All" : range.value}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </TooltipTrigger>
            <TooltipContent>{dateFilterLabel}</TooltipContent>
          </Tooltip>
        ) : null}
        <FilterPopover
          controller={filterController}
          onClear={() => {
            filterController.clearAllFilters();
            setCustomFieldFilters({});
            setExtensionFilters({});
          }}
          onOpenChange={setFilterMenuOpen}
          open={filterMenuOpen}
          renderRangeSubmenu={(group, clearLabel) => (
            <RangeSubmenuControl clearLabel={clearLabel} group={group} />
          )}
          viewModel={filterViewModel}
        />
        <div className="ml-auto hidden flex-wrap items-center justify-end gap-2 md:flex">
          {variant === "page" ? (
            <ToggleGroup
              aria-label="Artifact layout"
              onValueChange={(value) => {
                if (value === "list" || value === "board") {
                  setArtifactListLayout(value);
                }
              }}
              type="single"
              value={layout}
              variant="outline"
            >
              <ToggleGroupItem
                aria-label="List view"
                className="px-2 data-[variant=outline]:h-[26px]"
                value="list"
              >
                <ListIcon />
                List
              </ToggleGroupItem>
              <ToggleGroupItem
                aria-label="Board view"
                className="px-2 data-[variant=outline]:h-[26px]"
                value="board"
              >
                <Columns3Icon />
                Board
              </ToggleGroupItem>
            </ToggleGroup>
          ) : null}
          <ArtifactSortMenu
            active={sortActive}
            columns={configuredColumns}
            customFields={customFields}
            onClear={() => {
              setSortActive(false);
              setSortBy("name");
              setSortDir("asc");
            }}
            onSort={(column, direction) => {
              setSortActive(true);
              setSortBy(column);
              setSortDir(direction);
            }}
            sortBy={sortBy}
          />
          <ArtifactGroupMenu
            columns={configuredColumns}
            customFields={customFields}
            groupBy={groupBy}
            groupOrder={groupOrder}
            secondaryGroupBy={secondaryGroupBy}
            secondaryGroupOrder={secondaryGroupOrder}
            setGroupBy={setGroupBy}
            setGroupOrder={setGroupOrder}
            setSecondaryGroupBy={setSecondaryGroupBy}
            setSecondaryGroupOrder={setSecondaryGroupOrder}
            setShowEmptyGroups={setShowEmptyGroups}
            setShowEmptySubgroups={setShowEmptySubgroups}
            showEmptyGroups={showEmptyGroups}
            showEmptySubgroups={showEmptySubgroups}
          />
          <ArtifactOptionsMenu
            columnIds={visibleColumnIds}
            columns={configuredColumns}
            customFields={customFields}
            metricDefinitions={summaryMetricDefinitions}
            metricKeys={visibleMetricKeys}
            setColumnIds={setVisibleColumnIds}
            setMetricKeys={setVisibleMetricKeys}
          />
          <ArtifactSavedViewsMenu
            activeViewId={activeSavedViewId}
            onApply={applySavedView}
            onSave={saveCurrentView}
            views={savedViews}
          />
          {showAddFieldButton ? (
            <Button
              onClick={() => setAddFieldOpen(true)}
              size="sm"
              variant="outline"
            >
              <PlusIcon />
              Add field
            </Button>
          ) : null}
        </div>
        <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2 md:hidden">
          {variant === "page" ? (
            <ToggleGroup
              aria-label="Artifact layout"
              className="shrink-0"
              onValueChange={(value) => {
                if (value === "list" || value === "board") {
                  setArtifactListLayout(value);
                }
              }}
              type="single"
              value={layout}
              variant="outline"
            >
              <ToggleGroupItem aria-label="List view" value="list">
                <ListIcon />
              </ToggleGroupItem>
              <ToggleGroupItem aria-label="Board view" value="board">
                <Columns3Icon />
              </ToggleGroupItem>
            </ToggleGroup>
          ) : null}
          <ArtifactSavedViewsMenu
            activeViewId={activeSavedViewId}
            onApply={applySavedView}
            onSave={saveCurrentView}
            views={savedViews}
          />
          <ArtifactViewMenu
            columnIds={visibleColumnIds}
            columns={configuredColumns}
            customFields={customFields}
            groupBy={groupBy}
            metricDefinitions={summaryMetricDefinitions}
            metricKeys={visibleMetricKeys}
            onAddField={() => setAddFieldOpen(true)}
            onClearSort={() => {
              setSortActive(false);
              setSortBy("name");
              setSortDir("asc");
            }}
            onSort={(column) => {
              setSortActive(true);
              setSortBy(column);
              setSortDir("asc");
            }}
            secondaryGroupBy={secondaryGroupBy}
            setColumnIds={setVisibleColumnIds}
            setGroupBy={setGroupBy}
            setMetricKeys={setVisibleMetricKeys}
            setSecondaryGroupBy={setSecondaryGroupBy}
            showAddFieldButton={showAddFieldButton}
            sortBy={sortActive ? sortBy : "none"}
          />
        </div>
        {showAddArtifactButton ? (
          <Button onClick={() => setAddArtifactOpen(true)} size="sm">
            <PlusIcon />
            Add artifact
          </Button>
        ) : null}
      </div>
      {filtersActive ? (
        <div className="-mx-4 pt-2">
          <ActiveFiltersBar
            controller={filterController}
            renderRangeSubmenu={(group, clearLabel) => (
              <RangeSubmenuControl clearLabel={clearLabel} group={group} />
            )}
            viewModel={filterViewModel}
          />
        </div>
      ) : null}
    </div>
  );
}

export function ArtifactListResults({
  controller,
}: Readonly<{ controller: ArtifactListShellController }>) {
  const {
    dateDimension,
    listResultsRef,
    showSummaryCards,
    summaryMetrics,
    variant,
    visibleMetricKeys,
  } = controller;
  return (
    <div
      className={cn(
        "min-h-0 flex-1",
        variant === "page"
          ? "overflow-auto [contain:paint]"
          : "overflow-visible"
      )}
      ref={(element) => {
        listResultsRef.current = element;
        const hostRef = controller.host?.resultsRef;
        if (typeof hostRef === "function") {
          hostRef(element);
        } else if (hostRef) {
          hostRef.current = element;
        }
      }}
    >
      {renderArtifactHostSlot(
        controller.host,
        "summary",
        showSummaryCards ? (
          <div className="sticky left-0 px-4 pt-4 pb-3">
            <div className="flex snap-x snap-mandatory gap-3 overflow-x-auto pb-1 md:snap-none">
              {summaryMetrics
                .filter((metric) => visibleMetricKeys.has(metric.key))
                .map((metric) => (
                  <MetricCard
                    className="shrink-0 basis-[calc(100%_-_2.5rem)] snap-start md:min-w-44 md:flex-1 md:basis-auto"
                    delta={metric.delta}
                    deltaLabel={artifactDateComparisonLabel(dateDimension)}
                    deltaPolarity={metric.deltaPolarity}
                    info={metric.info}
                    key={metric.key}
                    label={metric.label}
                    value={metric.value}
                  />
                ))}
            </div>
          </div>
        ) : null
      )}

      {controller.host?.resultsNotice}
      {controller.host && "resultsState" in controller.host ? (
        controller.host.resultsState
      ) : (
        <ArtifactListRows controller={controller} />
      )}
    </div>
  );
}

function ArtifactListRows({
  controller,
}: Readonly<{ controller: ArtifactListShellController }>) {
  const { layout, tagEditorContext } = controller;
  return (
    <TagEditorContext.Provider value={tagEditorContext}>
      {layout === "board" ? (
        <ArtifactListBoard controller={controller} />
      ) : (
        <ArtifactListGrid controller={controller} />
      )}
    </TagEditorContext.Provider>
  );
}

function ArtifactListBoard({
  controller,
}: Readonly<{ controller: ArtifactListShellController }>) {
  // PRD-724 adoption rides manual-artifact-ordering (flag consolidation,
  // operator ruling 2026-10-20): with the key off, the Issues and Documents
  // boards keep main's ArtifactStatusBoard, including the selection and field
  // props #8980 gave it (ISS-12644 consolidation ruling).
  const sharedBoard = useManualArtifactOrderingEnabled();
  const {
    applyGroupDrop,
    changeArtifactStatus,
    creationConfig,
    displayedArtifacts,
    groupBy,
    groupedArtifacts,
    onOpenArtifact,
    onOpenArtifactHref,
    secondaryGroupBy,
    selectedArtifactIds,
    selectionNoun,
    selectionAnchorId,
    setAddArtifactOpen,
    setBoardCreationStatus,
    setSelectedArtifactIds,
    showBoardAddButton,
    statusBoard,
  } = controller;
  const boardProps: ComponentProps<typeof ArtifactStatusBoard> = {
    canGroupDrop: controller.host?.canGroupDrop,
    config: statusBoard,
    defaultKind: creationConfig.kind,
    groupBy,
    groups: groupedArtifacts ?? [],
    noun: selectionNoun,
    onAdd:
      showBoardAddButton && statusBoard.editable
        ? (status) => {
            if (controller.host?.onRequestBoardCreate) {
              controller.host.onRequestBoardCreate(status);
              return;
            }
            setBoardCreationStatus(status);
            setAddArtifactOpen(true);
          }
        : undefined,
    onGroupDrop: (id, field, value, secondaryField, secondaryValue) =>
      applyGroupDrop(
        id,
        field,
        value,
        secondaryField,
        secondaryValue,
        undefined,
        ArtifactStatusEditSurface.Board
      ),
    onOpen: onOpenArtifact,
    onOpenHref: onOpenArtifactHref,
    onStatusChange: (id, status) =>
      changeArtifactStatus(id, status, ArtifactStatusEditSurface.Board),
    renderStatusMenu: controller.host?.renderBoardStatusMenu,
    renderTitle: controller.host?.renderBoardTitle,
    secondaryGroupBy,
  };
  if (!sharedBoard) {
    return (
      <ArtifactStatusBoard
        {...boardProps}
        onSelect={(artifact, event) => {
          if ("button" in event) {
            controller.handleArtifactRowClick(
              artifact,
              event,
              controller.displayedArtifacts
            );
          } else {
            controller.handleArtifactRowKeyboardNavigate(
              artifact,
              event,
              controller.displayedArtifacts
            );
          }
        }}
        renderField={controller.host?.renderCell}
        selectedArtifactIds={selectedArtifactIds}
        visibleColumnIds={controller.visibleColumnIds}
      />
    );
  }
  return (
    <ArtifactListBoardView
      {...boardProps}
      onSelectionChange={(artifactId, intent) => {
        const rootIds = displayedArtifacts
          .filter((artifact) => !artifact.parentArtifactId)
          .map((artifact) => artifact.id);
        setSelectedArtifactIds((current) =>
          boardSelectionFromIntent(
            current,
            rootIds,
            artifactId,
            intent,
            selectionAnchorId
          )
        );
      }}
      onStatusChange={(id, status) =>
        changeArtifactStatus(id, status, ArtifactStatusEditSurface.Board)
      }
      selectedIds={selectedArtifactIds}
    />
  );
}

function boardSelectionFromIntent(
  current: ReadonlySet<string>,
  rootIds: readonly string[],
  artifactId: string,
  intent: ArtifactBoardSelectionIntent,
  anchorRef: { current: string | null }
) {
  return new Set(
    artifactBoardSelectionFromIntent(
      [...current],
      rootIds,
      artifactId,
      intent,
      anchorRef
    )
  );
}

function ArtifactListGrid({
  controller,
}: Readonly<{ controller: ArtifactListShellController }>) {
  const {
    applyGroupDrop,
    artifactColumnWidth,
    artifacts,
    columnFilterGroups,
    columnLayout,
    createInlineArtifact,
    customFields,
    displayedArtifacts,
    extensionColumns,
    gridColumns,
    groupBy,
    groupedArtifacts,
    handleArtifactRowClick,
    handleArtifactRowKeyboardNavigate,
    hierarchyRowForArtifact,
    hierarchyView,
    inlineCreate,
    inlineDraftContext,
    manualOrderingActive,
    moveArtifactManually,
    moveVisibleColumn,
    onOpenArtifact,
    onOpenArtifactHref,
    reconcileSelection,
    secondaryGroupBy,
    selectedArtifactIds,
    selectAllVisibleArtifacts,
    setAddFieldOpen,
    setArtifactColumnWidth,
    setColumnOrder,
    setColumnWidths,
    setGroupBy,
    setInlineDraftContext,
    setMobileArtifactSelected,
    setSortActive,
    setSortBy,
    setSortDir,
    showAddFieldButton,
    sortActive,
    sortBy,
    sortDir,
    statusBoard,
    toggleArtifactSelection,
    updateArtifact,
    updateArtifactTitle,
  } = controller;
  return (
    <GridTable
      canDragRow={(artifact) =>
        !(groupBy === "status" || secondaryGroupBy === "status") ||
        (statusBoard.editable &&
          genericArtifactStatusCapability(artifact).editable)
      }
      canDropOnGroup={(artifact, group, subgroup) => {
        const secondary =
          secondaryGroupBy === "none" ? undefined : secondaryGroupBy;
        if (controller.host?.canGroupDrop) {
          return controller.host.canGroupDrop(
            artifact,
            groupBy,
            group.key,
            secondary,
            subgroup?.key
          );
        }
        return (
          resolveArtifactGroupDestination(
            artifact,
            groupBy,
            group.key,
            secondary,
            subgroup?.key
          ) !== null
        );
      }}
      canDropOnRow={
        manualOrderingActive ? controller.host?.canHierarchyDrop : undefined
      }
      cardCompatibility={
        hierarchyView.enabled
          ? undefined
          : {
              render: (artifact, columns, favoriteAction) => (
                <GenericArtifactCardCompatibility
                  additionalColumns={extensionColumns}
                  artifact={artifact}
                  columns={columns}
                  customFields={customFields}
                  favoriteAction={favoriteAction}
                  onOpenArtifact={onOpenArtifact}
                  onSelectedChange={(selected) =>
                    setMobileArtifactSelected(artifact.id, selected)
                  }
                  referenceArtifacts={artifacts}
                  renderCell={controller.host?.renderCell}
                  renderLead={
                    controller.host?.renderLead
                      ? (artifact) =>
                          controller.host?.renderLead?.(artifact, {
                            isNarrowList: false,
                          })
                      : undefined
                  }
                  selected={selectedArtifactIds.has(artifact.id)}
                />
              ),
            }
      }
      columnOrder={columnLayout.columnOrder}
      columns={gridColumns}
      columnWidths={columnLayout.columnWidths}
      favorite={artifactListFavorite(controller)}
      getCardSelectionLabel={(artifact, selected) =>
        formatGridCardSelectionLabel(artifact.title, selected)
      }
      getRowId={(artifact) => artifact.id}
      gridTemplateColumns={columnLayout.gridTemplateColumns}
      groupCollapse={tableGroupCollapsePort({
        collapsedGroups: controller.collapsedGroups,
        grouping: artifactRouteGrouping(
          groupBy,
          secondaryGroupBy,
          controller.groupOrder,
          controller.secondaryGroupOrder
        ),
        groups: groupedArtifacts,
        isCompletePopulation: false,
        onCollapsedGroupsChange: controller.setCollapsedGroups,
      })}
      groups={groupedArtifacts}
      headerActions={{
        getFilterContent: (columnId) => {
          const group = columnFilterGroups.find(
            (candidate) => candidate.id === columnId
          );
          return group ? <FilterGroupContent group={group} /> : undefined;
        },
        onGroup: setGroupBy,
        onMove: moveVisibleColumn,
      }}
      isRowSelected={(artifact) => selectedArtifactIds.has(artifact.id)}
      items={displayedArtifacts}
      leadingColumnWidth={artifactColumnWidth}
      leadingLabel="Artifact"
      leadingSortKey="name"
      leadingTooltip="Optional column header tool tip..."
      mode="auto"
      movableColumnIds={columnLayout.movableColumnIds}
      onColumnOrderChange={(visibleOrder) =>
        setColumnOrder(columnLayout.toPersistedColumnOrder(visibleOrder))
      }
      onColumnWidthChange={(columnId, widthPx) =>
        setColumnWidths((current) => ({
          ...current,
          [columnId]: widthPx,
        }))
      }
      onGroupDrop={
        groupBy === "none" ||
        (groupBy === "status" && !statusBoard.editable) ||
        (secondaryGroupBy === "status" && !statusBoard.editable)
          ? undefined
          : (artifact, group, subgroup, placement) =>
              applyGroupDrop(
                artifact.id,
                groupBy,
                group.key,
                secondaryGroupBy === "none" ? undefined : secondaryGroupBy,
                subgroup?.key,
                placement,
                ArtifactStatusEditSurface.InlineCell
              )
      }
      onLeadingColumnWidthChange={setArtifactColumnWidth}
      onRenderedItemsChange={reconcileSelection}
      onRowClick={(artifact, event, renderedItems) => {
        if (event.currentTarget.hasAttribute("data-grid-card-id")) {
          toggleArtifactSelection(artifact);
          return;
        }
        handleArtifactRowClick(artifact, event, renderedItems);
      }}
      onRowDrop={
        manualOrderingActive ? controller.host?.onHierarchyDrop : undefined
      }
      onRowKeyboardNavigate={(artifact, event, renderedItems) => {
        if (event.currentTarget.hasAttribute("data-grid-card-id")) {
          toggleArtifactSelection(artifact);
          return;
        }
        handleArtifactRowKeyboardNavigate(artifact, event, renderedItems);
      }}
      onRowSelectionToggle={toggleArtifactSelection}
      onSelectAllRows={selectAllVisibleArtifacts}
      onSort={(column, direction) => {
        setSortActive(true);
        setSortBy(column);
        setSortDir(direction);
      }}
      renderAfterGroup={
        inlineCreate?.enabled
          ? (group) => (
              <TableInlineCreateRow
                active={
                  inlineDraftContext?.groupKey === group.key &&
                  !inlineDraftContext.afterArtifactId
                }
                gridTemplateColumns={columnLayout.gridTemplateColumns}
                label={inlineCreate.label ?? "Add artifact"}
                onActivate={
                  inlineCreate.onActivate ??
                  (() => setInlineDraftContext({ groupKey: group.key }))
                }
                onCancel={() => setInlineDraftContext(null)}
                onCommit={(title) => createInlineArtifact(title, group.key)}
              />
            )
          : undefined
      }
      renderAfterItem={
        inlineCreate?.enabled
          ? (artifact) =>
              inlineDraftContext?.afterArtifactId === artifact.id ? (
                <TableInlineCreateRow
                  active
                  gridTemplateColumns={columnLayout.gridTemplateColumns}
                  label={inlineCreate.label ?? "Add artifact"}
                  onActivate={() => undefined}
                  onCancel={() => setInlineDraftContext(null)}
                  onCommit={(title) =>
                    createInlineArtifact(
                      title,
                      inlineDraftContext.groupKey,
                      artifact.id
                    )
                  }
                />
              ) : null
          : undefined
      }
      renderAfterRows={
        inlineCreate?.enabled && groupBy === "none" ? (
          <TableInlineCreateRow
            active={
              inlineDraftContext !== null && !inlineDraftContext.afterArtifactId
            }
            gridTemplateColumns={columnLayout.gridTemplateColumns}
            label={inlineCreate.label ?? "Add artifact"}
            onActivate={
              inlineCreate.onActivate ?? (() => setInlineDraftContext({}))
            }
            onCancel={() => setInlineDraftContext(null)}
            onCommit={createInlineArtifact}
          />
        ) : undefined
      }
      renderCell={(columnId, artifact) =>
        controller.host?.renderCell
          ? controller.host.renderCell(columnId, artifact)
          : (extensionColumns
              .find((column) => column.id === columnId)
              ?.renderCell(artifact) ??
            renderGenericArtifactCell(
              columnId,
              artifact,
              customFields,
              artifacts,
              updateArtifact
            ))
      }
      renderLead={(artifact, context) => {
        if (controller.host?.renderLead) {
          return controller.host.renderLead(artifact, context);
        }
        const lead = (
          <EditableArtifactLead
            artifact={artifact}
            narrow={context.isNarrowList}
            onCommit={updateArtifactTitle}
            onOpenArtifact={onOpenArtifact}
            openHref={onOpenArtifactHref?.(artifact)}
          />
        );
        const responsiveLead = context.isNarrowList ? (
          <div className="flex min-w-0 items-center gap-2">
            {renderGenericArtifactCell(
              "status",
              artifact,
              customFields,
              artifacts,
              updateArtifact,
              ArtifactStatusVariant.Icon
            )}
            <div className="min-w-0 flex-1">{lead}</div>
          </div>
        ) : (
          lead
        );
        const row = hierarchyRowForArtifact(artifact);
        if (!row) {
          return responsiveLead;
        }
        return (
          <ArtifactHierarchyLead
            artifact={artifact}
            depth={row.depth}
            expanded={hierarchyView.isExpanded(artifact.id)}
            hasChildren={row.hasChildren}
            onToggleExpanded={hierarchyView.toggleExpanded}
            reorderControl={
              manualOrderingActive ? (
                <ArtifactHierarchyControls
                  artifact={artifact}
                  onMoveDown={() => moveArtifactManually(artifact.id, "down")}
                  onMoveIn={() => moveArtifactManually(artifact.id, "in")}
                  onMoveOut={() => moveArtifactManually(artifact.id, "out")}
                  onMoveUp={() => moveArtifactManually(artifact.id, "up")}
                />
              ) : null
            }
          >
            {responsiveLead}
          </ArtifactHierarchyLead>
        );
      }}
      resizableColumnIds={columnLayout.resizableColumnIds}
      rowDragPreviewLabel={
        manualOrderingActive ? (artifact) => artifact.title : undefined
      }
      sortBy={sortActive ? sortBy : null}
      sortDir={sortDir}
      trailingHeader={
        showAddFieldButton ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                aria-label="Add field"
                className="flex size-full items-center justify-center border-l text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
                onClick={() => setAddFieldOpen(true)}
                type="button"
              >
                <PlusIcon className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Add field</TooltipContent>
          </Tooltip>
        ) : undefined
      }
    />
  );
}
