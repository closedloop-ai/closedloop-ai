import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "./index.tsx",
    "components/ui/active-filters-bar":
      "./components/ui/active-filters-bar.tsx",
    "components/ui/active-filters-bar-v2":
      "./components/ui/active-filters-bar-v2.tsx",
    "components/ui/alert": "./components/ui/alert.tsx",
    "components/ui/alert-dialog": "./components/ui/alert-dialog.tsx",
    "components/ui/analytics-range-toggle":
      "./components/ui/analytics-range-toggle.tsx",
    "components/ui/avatar": "./components/ui/avatar.tsx",
    "components/ui/badge": "./components/ui/badge.tsx",
    "components/ui/brand-icons": "./components/ui/brand-icons.tsx",
    "components/ui/breadcrumb": "./components/ui/breadcrumb.tsx",
    "components/ui/button": "./components/ui/button.tsx",
    "components/ui/calendar": "./components/ui/calendar.tsx",
    "components/ui/card": "./components/ui/card.tsx",
    "components/ui/card-density": "./components/ui/card-density.ts",
    "components/ui/category-bar-chart":
      "./components/ui/category-bar-chart.tsx",
    "components/ui/chart": "./components/ui/chart.tsx",
    "components/ui/chart-colors": "./components/ui/chart-colors.ts",
    "components/ui/chart-series-fold": "./components/ui/chart-series-fold.ts",
    "components/ui/checkbox": "./components/ui/checkbox.tsx",
    "components/ui/checkbox-tree": "./components/ui/checkbox-tree.tsx",
    "components/ui/chip": "./components/ui/chip.tsx",
    "components/ui/collapsible": "./components/ui/collapsible.tsx",
    "components/ui/collapsible-section":
      "./components/ui/collapsible-section.tsx",
    "components/ui/command": "./components/ui/command.tsx",
    "components/ui/comment-action-menu":
      "./components/ui/comment-action-menu.tsx",
    "components/ui/comment-composer": "./components/ui/comment-composer.tsx",
    "components/ui/comment-thread": "./components/ui/comment-thread.tsx",
    "components/ui/comment-thread-action-footer":
      "./components/ui/comment-thread-action-footer.tsx",
    "components/ui/count-cell": "./components/ui/count-cell.tsx",
    "components/ui/data-table": "./components/ui/data-table.tsx",
    "components/ui/date-picker-popover":
      "./components/ui/date-picker-popover.tsx",
    "components/ui/dialog": "./components/ui/dialog.tsx",
    "components/ui/donut-chart": "./components/ui/donut-chart.tsx",
    "components/ui/donut-slice-textures":
      "./components/ui/donut-slice-textures.tsx",
    "components/ui/drag-preview-chip": "./components/ui/drag-preview-chip.tsx",
    "components/ui/drawer": "./components/ui/drawer.tsx",
    "components/ui/dropdown-menu": "./components/ui/dropdown-menu.tsx",
    "components/ui/empty": "./components/ui/empty.tsx",
    "components/ui/empty-state": "./components/ui/empty-state.tsx",
    "components/ui/favorite-button": "./components/ui/favorite-button.tsx",
    "components/ui/feed-rail": "./components/ui/feed-rail.tsx",
    "components/ui/filter-chip": "./components/ui/filter-chip.tsx",
    "components/ui/filter-popover": "./components/ui/filter-popover.tsx",
    "components/ui/filter-popover-v2": "./components/ui/filter-popover-v2.tsx",
    "components/ui/filter-range-submenu":
      "./components/ui/filter-range-submenu.tsx",
    "components/ui/filter-range-submenu-v2":
      "./components/ui/filter-range-submenu-v2.tsx",
    "components/ui/form": "./components/ui/form.tsx",
    "components/ui/grid-interaction-contract":
      "./components/ui/grid-interaction-contract.tsx",
    "components/ui/grid-row-drag-handle":
      "./components/ui/grid-row-drag-handle.tsx",
    "components/ui/grid-table": "./components/ui/grid-table.tsx",
    "components/ui/grid-table-card": "./components/ui/grid-table-card.tsx",
    "components/ui/grid-table-list-surface":
      "./components/ui/grid-table-list-surface.tsx",
    "components/ui/grid-table-toolbar":
      "./components/ui/grid-table-toolbar.tsx",
    "components/ui/grid-table-v2": "./components/ui/grid-table-v2.tsx",
    "components/ui/grid-table-v2-card":
      "./components/ui/grid-table-v2-card.tsx",
    "components/ui/grid-table-v2-cell":
      "./components/ui/grid-table-v2-cell.tsx",
    "components/ui/grid-table-v2-grouped-rows":
      "./components/ui/grid-table-v2-grouped-rows.tsx",
    "components/ui/grid-table-v2-section-header-row":
      "./components/ui/grid-table-v2-section-header-row.tsx",
    "components/ui/grid-table-v2-tooltip":
      "./components/ui/grid-table-v2-tooltip.tsx",
    "components/ui/grid-table-v2-tree-lead":
      "./components/ui/grid-table-v2-tree-lead.tsx",
    "components/ui/grid-table-v2-windowed-rows":
      "./components/ui/grid-table-v2-windowed-rows.tsx",
    "components/ui/group-section-header":
      "./components/ui/group-section-header.tsx",
    "components/ui/inline-edit-editor-shell":
      "./components/ui/inline-edit-editor-shell.tsx",
    "components/ui/inline-edit-failure-behavior":
      "./components/ui/inline-edit-failure-behavior.ts",
    "components/ui/inline-edit-feedback":
      "./components/ui/inline-edit-feedback.tsx",
    "components/ui/inline-name-cell": "./components/ui/inline-name-cell.tsx",
    "components/ui/inline-reference-cell":
      "./components/ui/inline-reference-cell.tsx",
    "components/ui/inline-scalar-cell":
      "./components/ui/inline-scalar-cell.tsx",
    "components/ui/inline-select-cell":
      "./components/ui/inline-select-cell.tsx",
    "components/ui/inline-tag-cell": "./components/ui/inline-tag-cell.tsx",
    "components/ui/input": "./components/ui/input.tsx",
    "components/ui/internal/status-icon-shared":
      "./components/ui/internal/status-icon-shared.tsx",
    "components/ui/invalid-state": "./components/ui/invalid-state.ts",
    "components/ui/label": "./components/ui/label.tsx",
    "components/ui/layout/kanban-board":
      "./components/ui/layout/kanban-board.tsx",
    "components/ui/layout/section": "./components/ui/layout/section.tsx",
    "components/ui/metadata-panel": "./components/ui/metadata-panel.tsx",
    "components/ui/mode-toggle": "./components/ui/mode-toggle.tsx",
    "components/ui/mono-id-cell": "./components/ui/mono-id-cell.tsx",
    "components/ui/move-between-sections-icon":
      "./components/ui/move-between-sections-icon.tsx",
    "components/ui/pagination": "./components/ui/pagination.tsx",
    "components/ui/person-avatar": "./components/ui/person-avatar.tsx",
    "components/ui/popover": "./components/ui/popover.tsx",
    "components/ui/primitives/activity-heatmap":
      "./components/ui/primitives/activity-heatmap.tsx",
    "components/ui/primitives/activity-heatmap-colors":
      "./components/ui/primitives/activity-heatmap-colors.ts",
    "components/ui/primitives/code-block":
      "./components/ui/primitives/code-block.tsx",
    "components/ui/primitives/copy-button":
      "./components/ui/primitives/copy-button.tsx",
    "components/ui/primitives/format-metric-value":
      "./components/ui/primitives/format-metric-value.ts",
    "components/ui/primitives/graph": "./components/ui/primitives/graph.tsx",
    "components/ui/primitives/graph-events":
      "./components/ui/primitives/graph-events.ts",
    "components/ui/primitives/info-hint":
      "./components/ui/primitives/info-hint.tsx",
    "components/ui/primitives/markdown-content":
      "./components/ui/primitives/markdown-content.tsx",
    "components/ui/primitives/metric-card":
      "./components/ui/primitives/metric-card.tsx",
    "components/ui/primitives/metric-card-lane":
      "./components/ui/primitives/metric-card-lane.tsx",
    "components/ui/primitives/metric-polarity":
      "./components/ui/primitives/metric-polarity.ts",
    "components/ui/primitives/ranked-bar":
      "./components/ui/primitives/ranked-bar.tsx",
    "components/ui/primitives/segmented-bar":
      "./components/ui/primitives/segmented-bar.tsx",
    "components/ui/primitives/sparkline":
      "./components/ui/primitives/sparkline.tsx",
    "components/ui/primitives/status-badge":
      "./components/ui/primitives/status-badge.tsx",
    "components/ui/primitives/underline-tabs":
      "./components/ui/primitives/underline-tabs.tsx",
    "components/ui/primitives/unified-diff":
      "./components/ui/primitives/unified-diff.tsx",
    "components/ui/priority-badge": "./components/ui/priority-badge.tsx",
    "components/ui/priority-icon": "./components/ui/priority-icon.tsx",
    "components/ui/progress": "./components/ui/progress.tsx",
    "components/ui/radio-group": "./components/ui/radio-group.tsx",
    "components/ui/resizable": "./components/ui/resizable.tsx",
    "components/ui/resizable-layout-storage":
      "./components/ui/resizable-layout-storage.ts",
    "components/ui/scroll-area": "./components/ui/scroll-area.tsx",
    "components/ui/section-header": "./components/ui/section-header.tsx",
    "components/ui/select": "./components/ui/select.tsx",
    "components/ui/separator": "./components/ui/separator.tsx",
    "components/ui/sheet": "./components/ui/sheet.tsx",
    "components/ui/sidebar": "./components/ui/sidebar.tsx",
    "components/ui/sidebar-collapsible-section":
      "./components/ui/sidebar-collapsible-section.tsx",
    "components/ui/sidebar-count-badge":
      "./components/ui/sidebar-count-badge.tsx",
    "components/ui/skeleton": "./components/ui/skeleton.tsx",
    "components/ui/sonner": "./components/ui/sonner.tsx",
    "components/ui/sortable-column-header":
      "./components/ui/sortable-column-header.tsx",
    "components/ui/sortable-subtree": "./components/ui/sortable-subtree.tsx",
    "components/ui/status-icon": "./components/ui/status-icon.tsx",
    "components/ui/status-icon-primitives":
      "./components/ui/status-icon-primitives.tsx",
    "components/ui/status-metadata-section":
      "./components/ui/status-metadata-section.tsx",
    "components/ui/status-percentage-icon":
      "./components/ui/status-percentage-icon.tsx",
    "components/ui/switch": "./components/ui/switch.tsx",
    "components/ui/table": "./components/ui/table.tsx",
    "components/ui/table-add-field-dialog":
      "./components/ui/table-add-field-dialog.tsx",
    "components/ui/table-add-field-dialog-colors":
      "./components/ui/table-add-field-dialog-colors.ts",
    "components/ui/table-add-field-dialog-content":
      "./components/ui/table-add-field-dialog-content.tsx",
    "components/ui/table-bulk-action-bar":
      "./components/ui/table-bulk-action-bar.tsx",
    "components/ui/table-bulk-actions":
      "./components/ui/table-bulk-actions.tsx",
    "components/ui/table-cell-list-primitives":
      "./components/ui/table-cell-list-primitives.tsx",
    "components/ui/table-cell-primitives":
      "./components/ui/table-cell-primitives.tsx",
    "components/ui/table-cell-semantic-primitives":
      "./components/ui/table-cell-semantic-primitives.tsx",
    "components/ui/table-cell-value-state":
      "./components/ui/table-cell-value-state.ts",
    "components/ui/table-compact-view-menu-v2":
      "./components/ui/table-compact-view-menu-v2.tsx",
    "components/ui/table-filter-menu": "./components/ui/table-filter-menu.tsx",
    "components/ui/table-filters": "./components/ui/table-filters.ts",
    "components/ui/table-filters-v2": "./components/ui/table-filters-v2.ts",
    "components/ui/table-grid-column-menu":
      "./components/ui/table-grid-column-menu.tsx",
    "components/ui/table-grid-header": "./components/ui/table-grid-header.tsx",
    "components/ui/table-grid-header-handles":
      "./components/ui/table-grid-header-handles.tsx",
    "components/ui/table-grid-header-v2":
      "./components/ui/table-grid-header-v2.tsx",
    "components/ui/table-grid-header-v2-handles":
      "./components/ui/table-grid-header-v2-handles.tsx",
    "components/ui/table-grid-header-v2-label":
      "./components/ui/table-grid-header-v2-label.tsx",
    "components/ui/table-group-menu-v2":
      "./components/ui/table-group-menu-v2.tsx",
    "components/ui/table-inline-create-row":
      "./components/ui/table-inline-create-row.tsx",
    "components/ui/table-options-menu-v2":
      "./components/ui/table-options-menu-v2.tsx",
    "components/ui/table-page-size-select":
      "./components/ui/table-page-size-select.tsx",
    "components/ui/table-pagination": "./components/ui/table-pagination.tsx",
    "components/ui/table-pagination-footer":
      "./components/ui/table-pagination-footer.tsx",
    "components/ui/table-pagination-v2":
      "./components/ui/table-pagination-v2.tsx",
    "components/ui/table-saved-views-menu-v2":
      "./components/ui/table-saved-views-menu-v2.tsx",
    "components/ui/table-sort-menu-v2":
      "./components/ui/table-sort-menu-v2.tsx",
    "components/ui/table-toolbar-model":
      "./components/ui/table-toolbar-model.ts",
    "components/ui/table-toolbar-toggles-v2":
      "./components/ui/table-toolbar-toggles-v2.tsx",
    "components/ui/table-view-menu": "./components/ui/table-view-menu.tsx",
    "components/ui/tabs": "./components/ui/tabs.tsx",
    "components/ui/textarea": "./components/ui/textarea.tsx",
    "components/ui/theme-submenu": "./components/ui/theme-submenu.tsx",
    "components/ui/time-series-area-chart":
      "./components/ui/time-series-area-chart.tsx",
    "components/ui/toggle": "./components/ui/toggle.tsx",
    "components/ui/toggle-group": "./components/ui/toggle-group.tsx",
    "components/ui/tone-label": "./components/ui/tone-label.tsx",
    "components/ui/tooltip": "./components/ui/tooltip.tsx",
    "components/ui/types": "./components/ui/types.ts",
    "components/ui/use-commit-ledger": "./components/ui/use-commit-ledger.ts",
    "components/ui/use-dirty-edit-guard":
      "./components/ui/use-dirty-edit-guard.ts",
    "components/ui/user-select-popover":
      "./components/ui/user-select-popover.tsx",
    "components/ui/utils": "./components/ui/utils.ts",
    "hooks/use-alt-key-held": "./hooks/use-alt-key-held.ts",
    "hooks/use-container-width": "./hooks/use-container-width.ts",
    "hooks/use-copy-to-clipboard": "./hooks/use-copy-to-clipboard.ts",
    "hooks/use-grid-cell-tab-stops": "./hooks/use-grid-cell-tab-stops.ts",
    "hooks/use-grid-rendered-items-change":
      "./hooks/use-grid-rendered-items-change.ts",
    "hooks/use-grid-row-range-drag": "./hooks/use-grid-row-range-drag.ts",
    "hooks/use-grid-row-selection": "./hooks/use-grid-row-selection.ts",
    "hooks/use-grid-row-window": "./hooks/use-grid-row-window.ts",
    "hooks/use-grid-table-v2-touch-selection":
      "./hooks/use-grid-table-v2-touch-selection.ts",
    "hooks/use-grid-windowed-row-navigation":
      "./hooks/use-grid-windowed-row-navigation.ts",
    "hooks/use-held-menu-options": "./hooks/use-held-menu-options.ts",
    "hooks/use-isomorphic-layout-effect":
      "./hooks/use-isomorphic-layout-effect.ts",
    "hooks/use-media-query": "./hooks/use-media-query.ts",
    "hooks/use-mobile": "./hooks/use-mobile.ts",
    "hooks/use-modal-dialog-open": "./hooks/use-modal-dialog-open.tsx",
    "hooks/use-responsive-modal": "./hooks/use-responsive-modal.tsx",
    "hooks/use-settled-value": "./hooks/use-settled-value.ts",
    "lib/checkbox-tree": "./lib/checkbox-tree.ts",
    "lib/collapse-columns": "./lib/collapse-columns.ts",
    "lib/column-cell-alignment": "./lib/column-cell-alignment.ts",
    "lib/column-fold": "./lib/column-fold.ts",
    "lib/column-layout": "./lib/column-layout.ts",
    "lib/column-order": "./lib/column-order.ts",
    "lib/column-registry": "./lib/column-registry.ts",
    "lib/completion-percentage": "./lib/completion-percentage.ts",
    "lib/count-noun": "./lib/count-noun.ts",
    "lib/fonts": "./lib/fonts.ts",
    "lib/grid-cell-keyboard": "./lib/grid-cell-keyboard.ts",
    "lib/grid-cell-tab-stops": "./lib/grid-cell-tab-stops.ts",
    "lib/grid-interaction-contract": "./lib/grid-interaction-contract.ts",
    "lib/grid-row-action": "./lib/grid-row-action.ts",
    "lib/grid-row-drag-image": "./lib/grid-row-drag-image.ts",
    "lib/grid-row-drag-pointer-intent": "./lib/grid-row-drag-pointer-intent.ts",
    "lib/grid-row-window": "./lib/grid-row-window.ts",
    "lib/grid-table-aria": "./lib/grid-table-aria.ts",
    "lib/grid-table-navigation": "./lib/grid-table-navigation.ts",
    "lib/grid-table-pin": "./lib/grid-table-pin.ts",
    "lib/grid-table-v2-after-row": "./lib/grid-table-v2-after-row.ts",
    "lib/grid-table-v2-chrome-rows": "./lib/grid-table-v2-chrome-rows.ts",
    "lib/grid-table-v2-column-controls":
      "./lib/grid-table-v2-column-controls.ts",
    "lib/grid-table-v2-constants": "./lib/grid-table-v2-constants.ts",
    "lib/grid-table-v2-expansion-commands":
      "./lib/grid-table-v2-expansion-commands.ts",
    "lib/grid-table-v2-group-drop": "./lib/grid-table-v2-group-drop.ts",
    "lib/grid-table-v2-responsive": "./lib/grid-table-v2-responsive.ts",
    "lib/grid-table-v2-row-drag": "./lib/grid-table-v2-row-drag.ts",
    "lib/grid-table-v2-rows": "./lib/grid-table-v2-rows.ts",
    "lib/grid-table-v2-selection": "./lib/grid-table-v2-selection.ts",
    "lib/grid-table-v2-tree": "./lib/grid-table-v2-tree.ts",
    "lib/grid-table-v2-types": "./lib/grid-table-v2-types.ts",
    "lib/inline-cell-contract": "./lib/inline-cell-contract.ts",
    "lib/keyboard-activation": "./lib/keyboard-activation.ts",
    "lib/keyboard-event-key": "./lib/keyboard-event-key.ts",
    "lib/priority-order": "./lib/priority-order.ts",
    "lib/scroll-parent": "./lib/scroll-parent.ts",
    "lib/table-bulk-action-bar-layout": "./lib/table-bulk-action-bar-layout.ts",
    "lib/table-cell-alignment": "./lib/table-cell-alignment.ts",
    "lib/table-saved-views": "./lib/table-saved-views.ts",
    "lib/utils": "./lib/utils.ts",
    "lib/view-state-codec": "./lib/view-state-codec.ts",
    "lib/view-state-url-revision": "./lib/view-state-url-revision.ts",
    "lib/vocabulary/priority-order": "./lib/vocabulary/priority-order.ts",
    "providers/theme": "./providers/theme.tsx",
    "storybook/component-catalog": "./storybook/component-catalog.ts",
    "storybook/mock-data": "./storybook/mock-data.ts",
    "storybook/remount-key": "./storybook/remount-key.ts",
    "test/grid-roving-tab-stop": "./test/grid-roving-tab-stop.ts",
    "test/inline-scalar-cell-fixtures": "./test/inline-scalar-cell-fixtures.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  esbuildOptions(options) {
    options.jsx = "automatic";
  },
});
