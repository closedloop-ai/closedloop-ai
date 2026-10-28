export const canonicalStorybookLevels = ["Foundations","Primitives","Composites","Patterns","Surfaces"] as const;

export type StorybookCatalogLevel = (typeof canonicalStorybookLevels)[number];

export type StorybookCatalogEntry = {
  id: string;
  label: string;
  sourcePath: string;
  level: StorybookCatalogLevel;
  pathSegments: readonly string[];
  version?: string;
  storyTitle: string;
  storyId?: string;
  storyStatus?: "catalog-only";
  internal?: boolean;
  note?: string;
};

export const designSystemComponentCatalog =
  [
  {
    "id": "activity-heatmap",
    "label": "Activity Heatmap",
    "sourcePath": "packages/design-system/components/ui/primitives/activity-heatmap.tsx",
    "level": "Composites",
    "pathSegments": [
      "Charts"
    ],
    "storyId": "activity-heatmap",
    "storyTitle": "Composites v1.0/Charts/Activity Heatmap"
  },
  {
    "id": "analytics-range-toggle",
    "label": "Analytics Range Toggle",
    "sourcePath": "packages/design-system/components/ui/analytics-range-toggle.tsx",
    "level": "Composites",
    "pathSegments": [
      "Charts"
    ],
    "storyId": "analytics-range-toggle",
    "storyTitle": "Composites v1.0/Charts/Analytics Range Toggle"
  },
  {
    "id": "category-bar-chart",
    "label": "Category Bar Chart",
    "sourcePath": "packages/design-system/components/ui/category-bar-chart.tsx",
    "level": "Composites",
    "pathSegments": [
      "Charts"
    ],
    "storyId": "category-bar-chart",
    "storyTitle": "Composites v1.0/Charts/Category Bar Chart"
  },
  {
    "id": "donut-chart",
    "label": "Donut Chart",
    "sourcePath": "packages/design-system/components/ui/donut-chart.tsx",
    "level": "Composites",
    "pathSegments": [
      "Charts"
    ],
    "storyId": "donut-chart",
    "storyTitle": "Composites v1.0/Charts/Donut Chart"
  },
  {
    "id": "time-series-area-chart",
    "label": "Time Series Area Chart",
    "sourcePath": "packages/design-system/components/ui/time-series-area-chart.tsx",
    "level": "Composites",
    "pathSegments": [
      "Charts"
    ],
    "storyId": "time-series-area-chart",
    "storyTitle": "Composites v1.0/Charts/Time Series Area Chart"
  },
  {
    "id": "code-block",
    "label": "Code Block",
    "sourcePath": "packages/design-system/components/ui/primitives/code-block.tsx",
    "level": "Composites",
    "pathSegments": [
      "Content"
    ],
    "storyId": "code-block",
    "storyTitle": "Composites v1.0/Content/Code Block"
  },
  {
    "id": "markdown-content",
    "label": "Markdown Content",
    "sourcePath": "packages/design-system/components/ui/primitives/markdown-content.tsx",
    "level": "Composites",
    "pathSegments": [
      "Content"
    ],
    "storyId": "markdown-content",
    "storyTitle": "Composites v1.0/Content/Markdown Content"
  },
  {
    "id": "count-cell",
    "label": "Count Cell",
    "sourcePath": "packages/design-system/components/ui/count-cell.tsx",
    "level": "Composites",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "count-cell",
    "storyTitle": "Composites v1.0/Data Display/Count Cell"
  },
  {
    "id": "inline-date-cell",
    "label": "Inline Date Cell",
    "sourcePath": "packages/design-system/components/ui/inline-date-cell.tsx",
    "level": "Composites",
    "pathSegments": [
      "Data Display"
    ],
    "storyStatus": "catalog-only",
    "note": "The date variant of Inline Scalar Cell, reached through type=\"date\". Its stories are on Composites/Shared/Artifact List/Inline Scalar Cell: Dates, Retained Date Save Failure and Date Write Rejects.",
    "storyTitle": "Composites v1.0/Data Display/Inline Date Cell"
  },
  {
    "id": "inline-scalar-cell",
    "label": "Inline Scalar Cell",
    "sourcePath": "packages/design-system/components/ui/inline-scalar-cell.tsx",
    "level": "Composites",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "inline-scalar-cell",
    "storyTitle": "Composites v1.0/Data Display/Inline Scalar Cell"
  },
  {
    "id": "inline-select-cell",
    "label": "Inline Select Cell",
    "sourcePath": "packages/design-system/components/ui/inline-select-cell.tsx",
    "level": "Composites",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "inline-select-cell",
    "storyTitle": "Composites v1.0/Data Display/Inline Select Cell"
  },
  {
    "id": "metadata-panel",
    "label": "Metadata Panel",
    "sourcePath": "packages/design-system/components/ui/metadata-panel.tsx",
    "level": "Composites",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "metadata-panel",
    "storyTitle": "Composites v1.0/Data Display/Metadata Panel"
  },
  {
    "id": "metric-card",
    "label": "Metric Card",
    "sourcePath": "packages/design-system/components/ui/primitives/metric-card.tsx",
    "level": "Composites",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "metric-card",
    "storyTitle": "Composites v1.0/Data Display/Metric Card"
  },
  {
    "id": "mono-id-cell",
    "label": "Mono ID Cell",
    "sourcePath": "packages/design-system/components/ui/mono-id-cell.tsx",
    "level": "Composites",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "mono-id-cell",
    "storyTitle": "Composites v1.0/Data Display/Mono ID Cell"
  },
  {
    "id": "data-table",
    "label": "Data Table",
    "sourcePath": "packages/design-system/components/ui/data-table.tsx",
    "level": "Composites",
    "pathSegments": [
      "Data Display",
      "Tables"
    ],
    "storyId": "data-table",
    "storyTitle": "Composites v1.0/Data Display/Tables/Data Table"
  },
  {
    "id": "grid-table",
    "label": "Grid Table",
    "sourcePath": "packages/design-system/components/ui/grid-table.tsx",
    "level": "Composites",
    "pathSegments": [
      "Data Display",
      "Tables"
    ],
    "storyId": "grid-table",
    "note": "Superseded by Grid Table V2, which is the champion Gridview implementation (ISS-9289). Compose Grid Table V2 on new surfaces; the modules still rendering this one migrate on their own tickets. Its column primitives (GridTableColumn, ROW_ACTIONS_COLUMN) remain canonical and are shared by both.",
    "storyTitle": "Composites v1.0/Data Display/Tables/Grid Table"
  },
  {
    "id": "grid-table-card",
    "label": "Grid Table Card",
    "sourcePath": "packages/design-system/components/ui/grid-table-card.tsx",
    "level": "Composites",
    "pathSegments": [
      "Data Display",
      "Tables"
    ],
    "storyId": "grid-table-card",
    "storyTitle": "Composites v1.0/Data Display/Tables/Grid Table Card"
  },
  {
    "id": "grid-table-toolbar",
    "label": "Grid Table Toolbar",
    "sourcePath": "packages/design-system/components/ui/grid-table-toolbar.tsx",
    "level": "Composites",
    "pathSegments": [
      "Data Display",
      "Tables"
    ],
    "storyId": "grid-table-toolbar",
    "storyTitle": "Composites v1.0/Data Display/Tables/Grid Table Toolbar"
  },
  {
    "id": "grid-table-v2",
    "label": "Grid Table V2",
    "sourcePath": "packages/design-system/components/ui/grid-table-v2.tsx",
    "level": "Composites",
    "pathSegments": [
      "Data Display",
      "Tables"
    ],
    "storyId": "grid-table-v2",
    "storyTitle": "Composites v1.0/Data Display/Tables/Grid Table V2"
  },
  {
    "id": "grid-table-v2-card",
    "label": "Grid Table V2 Card",
    "sourcePath": "packages/design-system/components/ui/grid-table-v2-card.tsx",
    "level": "Composites",
    "pathSegments": [
      "Data Display",
      "Tables"
    ],
    "storyId": "grid-table-v2-card",
    "storyTitle": "Composites v1.0/Data Display/Tables/Grid Table V2 Card"
  },
  {
    "id": "grid-table-v2-card-list",
    "label": "Grid Table V2 Card List",
    "sourcePath": "packages/design-system/components/ui/grid-table-v2-card-list.tsx",
    "level": "Composites",
    "pathSegments": [
      "Data Display",
      "Tables"
    ],
    "storyId": "grid-table-v2-card-list",
    "storyTitle": "Composites v1.0/Data Display/Tables/Grid Table V2 Card List"
  },
  {
    "id": "grid-table-v2-section-header-row",
    "label": "Grid Table V2 Section Header Row",
    "sourcePath": "packages/design-system/components/ui/grid-table-v2-section-header-row.tsx",
    "level": "Composites",
    "pathSegments": [
      "Data Display",
      "Tables"
    ],
    "storyId": "grid-table-v2-section-header-row",
    "storyTitle": "Composites v1.0/Data Display/Tables/Grid Table V2 Section Header Row"
  },
  {
    "id": "table-add-field-dialog",
    "label": "Table Add Field Dialog",
    "sourcePath": "packages/design-system/components/ui/table-add-field-dialog.tsx",
    "level": "Composites",
    "pathSegments": [
      "Data Display",
      "Tables"
    ],
    "storyId": "table-add-field-dialog",
    "storyTitle": "Composites v1.0/Data Display/Tables/Table Add Field Dialog"
  },
  {
    "id": "table-add-field-dialog-content",
    "label": "Table Add Field Dialog Content",
    "sourcePath": "packages/design-system/components/ui/table-add-field-dialog-content.tsx",
    "level": "Composites",
    "pathSegments": [
      "Data Display",
      "Tables"
    ],
    "storyStatus": "catalog-only",
    "storyTitle": "Composites v1.0/Data Display/Tables/Table Add Field Dialog Content"
  },
  {
    "id": "table-add-field-dialog-fields",
    "label": "Table Add Field Dialog Fields",
    "sourcePath": "packages/design-system/components/ui/table-add-field-dialog-fields.tsx",
    "level": "Composites",
    "pathSegments": [
      "Data Display",
      "Tables"
    ],
    "storyStatus": "catalog-only",
    "storyTitle": "Composites v1.0/Data Display/Tables/Table Add Field Dialog Fields"
  },
  {
    "id": "table-bulk-action-bar",
    "label": "Table Bulk Action Bar",
    "sourcePath": "packages/design-system/components/ui/table-bulk-action-bar.tsx",
    "level": "Composites",
    "pathSegments": [
      "Data Display",
      "Tables"
    ],
    "storyId": "table-bulk-action-bar",
    "storyTitle": "Composites v1.0/Data Display/Tables/Table Bulk Action Bar"
  },
  {
    "id": "table-bulk-actions",
    "label": "Table Bulk Actions",
    "sourcePath": "packages/design-system/components/ui/table-bulk-actions.tsx",
    "level": "Composites",
    "pathSegments": [
      "Data Display",
      "Tables"
    ],
    "storyId": "table-bulk-actions",
    "storyTitle": "Composites v1.0/Data Display/Tables/Table Bulk Actions"
  },
  {
    "id": "table-cell-list-primitives",
    "label": "Table Cell List Primitives",
    "sourcePath": "packages/design-system/components/ui/table-cell-list-primitives.tsx",
    "level": "Composites",
    "pathSegments": [
      "Data Display",
      "Tables"
    ],
    "storyId": "table-cell-list-primitives",
    "storyTitle": "Composites v1.0/Data Display/Tables/Table Cell List Primitives"
  },
  {
    "id": "table-cell-primitives",
    "label": "Table Cell Primitives",
    "sourcePath": "packages/design-system/components/ui/table-cell-primitives.tsx",
    "level": "Composites",
    "pathSegments": [
      "Data Display",
      "Tables"
    ],
    "storyId": "table-cell-primitives",
    "storyTitle": "Composites v1.0/Data Display/Tables/Table Cell Primitives"
  },
  {
    "id": "table-cell-semantic-primitives",
    "label": "Table Cell Semantic Primitives",
    "sourcePath": "packages/design-system/components/ui/table-cell-semantic-primitives.tsx",
    "level": "Composites",
    "pathSegments": [
      "Data Display",
      "Tables"
    ],
    "storyId": "table-cell-semantic-primitives",
    "storyTitle": "Composites v1.0/Data Display/Tables/Table Cell Semantic Primitives"
  },
  {
    "id": "table-compact-view-menu-v2",
    "label": "Table Compact View Menu V2",
    "sourcePath": "packages/design-system/components/ui/table-compact-view-menu-v2.tsx",
    "level": "Composites",
    "pathSegments": [
      "Data Display",
      "Tables"
    ],
    "storyStatus": "catalog-only",
    "storyTitle": "Composites v1.0/Data Display/Tables/Table Compact View Menu V2"
  },
  {
    "id": "table-filter-menu",
    "label": "Table Filter Menu",
    "sourcePath": "packages/design-system/components/ui/table-filter-menu.tsx",
    "level": "Composites",
    "pathSegments": [
      "Data Display",
      "Tables"
    ],
    "storyId": "table-filter-menu",
    "storyTitle": "Composites v1.0/Data Display/Tables/Table Filter Menu"
  },
  {
    "id": "table-grid-column-menu",
    "label": "Table Grid Column Menu",
    "sourcePath": "packages/design-system/components/ui/table-grid-column-menu.tsx",
    "level": "Composites",
    "pathSegments": [
      "Data Display",
      "Tables"
    ],
    "storyId": "table-grid-column-menu",
    "storyTitle": "Composites v1.0/Data Display/Tables/Table Grid Column Menu"
  },
  {
    "id": "table-grid-header",
    "label": "Table Grid Header",
    "sourcePath": "packages/design-system/components/ui/table-grid-header.tsx",
    "level": "Composites",
    "pathSegments": [
      "Data Display",
      "Tables"
    ],
    "storyId": "table-grid-header",
    "storyTitle": "Composites v1.0/Data Display/Tables/Table Grid Header"
  },
  {
    "id": "table-grid-header-handles",
    "label": "Table Grid Header Handles",
    "sourcePath": "packages/design-system/components/ui/table-grid-header-handles.tsx",
    "level": "Composites",
    "pathSegments": [
      "Data Display",
      "Tables"
    ],
    "storyId": "table-grid-header-handles",
    "storyTitle": "Composites v1.0/Data Display/Tables/Table Grid Header Handles"
  },
  {
    "id": "table-grid-header-v2",
    "label": "Table Grid Header V2",
    "sourcePath": "packages/design-system/components/ui/table-grid-header-v2.tsx",
    "level": "Composites",
    "pathSegments": [
      "Data Display",
      "Tables"
    ],
    "storyId": "table-grid-header-v2",
    "storyTitle": "Composites v1.0/Data Display/Tables/Table Grid Header V2"
  },
  {
    "id": "table-grid-header-v2-handles",
    "label": "Table Grid Header V2 Handles",
    "sourcePath": "packages/design-system/components/ui/table-grid-header-v2-handles.tsx",
    "level": "Composites",
    "pathSegments": [
      "Data Display",
      "Tables"
    ],
    "storyId": "table-grid-header-v2-handles",
    "storyTitle": "Composites v1.0/Data Display/Tables/Table Grid Header V2 Handles"
  },
  {
    "id": "table-grid-header-v2-label",
    "label": "Table Grid Header V2 Label",
    "sourcePath": "packages/design-system/components/ui/table-grid-header-v2-label.tsx",
    "level": "Composites",
    "pathSegments": [
      "Data Display",
      "Tables"
    ],
    "storyId": "table-grid-header-v2-label",
    "storyTitle": "Composites v1.0/Data Display/Tables/Table Grid Header V2 Label"
  },
  {
    "id": "table-group-menu-v2",
    "label": "Table Group Menu V2",
    "sourcePath": "packages/design-system/components/ui/table-group-menu-v2.tsx",
    "level": "Composites",
    "pathSegments": [
      "Data Display",
      "Tables"
    ],
    "storyStatus": "catalog-only",
    "storyTitle": "Composites v1.0/Data Display/Tables/Table Group Menu V2"
  },
  {
    "id": "table-inline-create-row",
    "label": "Table Inline Create Row",
    "sourcePath": "packages/design-system/components/ui/table-inline-create-row.tsx",
    "level": "Composites",
    "pathSegments": [
      "Data Display",
      "Tables"
    ],
    "storyId": "table-inline-create-row",
    "storyTitle": "Composites v1.0/Data Display/Tables/Table Inline Create Row"
  },
  {
    "id": "table-options-menu-v2",
    "label": "Table Options Menu V2",
    "sourcePath": "packages/design-system/components/ui/table-options-menu-v2.tsx",
    "level": "Composites",
    "pathSegments": [
      "Data Display",
      "Tables"
    ],
    "storyStatus": "catalog-only",
    "storyTitle": "Composites v1.0/Data Display/Tables/Table Options Menu V2"
  },
  {
    "id": "table-page-size-select",
    "label": "Table Page Size Select",
    "sourcePath": "packages/design-system/components/ui/table-page-size-select.tsx",
    "level": "Composites",
    "pathSegments": [
      "Data Display",
      "Tables"
    ],
    "storyId": "table-page-size-select",
    "storyTitle": "Composites v1.0/Data Display/Tables/Table Page Size Select"
  },
  {
    "id": "table-pagination-footer",
    "label": "Table Pagination Footer",
    "sourcePath": "packages/design-system/components/ui/table-pagination-footer.tsx",
    "level": "Composites",
    "pathSegments": [
      "Data Display",
      "Tables"
    ],
    "storyId": "table-pagination-footer",
    "storyTitle": "Composites v1.0/Data Display/Tables/Table Pagination Footer"
  },
  {
    "id": "table-pagination-v2",
    "label": "Table Pagination V2",
    "sourcePath": "packages/design-system/components/ui/table-pagination-v2.tsx",
    "level": "Composites",
    "pathSegments": [
      "Data Display",
      "Tables"
    ],
    "storyId": "table-pagination-v2",
    "storyTitle": "Composites v1.0/Data Display/Tables/Table Pagination V2"
  },
  {
    "id": "table-saved-views-menu-v2",
    "label": "Table Saved Views Menu V2",
    "sourcePath": "packages/design-system/components/ui/table-saved-views-menu-v2.tsx",
    "level": "Composites",
    "pathSegments": [
      "Data Display",
      "Tables"
    ],
    "storyStatus": "catalog-only",
    "storyTitle": "Composites v1.0/Data Display/Tables/Table Saved Views Menu V2"
  },
  {
    "id": "table-sort-menu-v2",
    "label": "Table Sort Menu V2",
    "sourcePath": "packages/design-system/components/ui/table-sort-menu-v2.tsx",
    "level": "Composites",
    "pathSegments": [
      "Data Display",
      "Tables"
    ],
    "storyStatus": "catalog-only",
    "storyTitle": "Composites v1.0/Data Display/Tables/Table Sort Menu V2"
  },
  {
    "id": "table-toolbar-toggles-v2",
    "label": "Table Toolbar Toggles V2",
    "sourcePath": "packages/design-system/components/ui/table-toolbar-toggles-v2.tsx",
    "level": "Composites",
    "pathSegments": [
      "Data Display",
      "Tables"
    ],
    "storyStatus": "catalog-only",
    "storyTitle": "Composites v1.0/Data Display/Tables/Table Toolbar Toggles V2"
  },
  {
    "id": "table-view-menu",
    "label": "Table View Menu",
    "sourcePath": "packages/design-system/components/ui/table-view-menu.tsx",
    "level": "Composites",
    "pathSegments": [
      "Data Display",
      "Tables"
    ],
    "storyId": "table-view-menu",
    "storyTitle": "Composites v1.0/Data Display/Tables/Table View Menu"
  },
  {
    "id": "comment-action-menu",
    "label": "Comment Action Menu",
    "sourcePath": "packages/design-system/components/ui/comment-action-menu.tsx",
    "level": "Composites",
    "pathSegments": [
      "Documents"
    ],
    "storyId": "comment-action-menu",
    "storyTitle": "Composites v1.0/Documents/Comment Action Menu"
  },
  {
    "id": "comment-composer",
    "label": "Comment Composer",
    "sourcePath": "packages/design-system/components/ui/comment-composer.tsx",
    "level": "Composites",
    "pathSegments": [
      "Documents"
    ],
    "storyId": "comment-composer",
    "storyTitle": "Composites v1.0/Documents/Comment Composer"
  },
  {
    "id": "comment-thread",
    "label": "Comment Thread",
    "sourcePath": "packages/design-system/components/ui/comment-thread.tsx",
    "level": "Composites",
    "pathSegments": [
      "Documents"
    ],
    "storyId": "comment-thread",
    "storyTitle": "Composites v1.0/Documents/Comment Thread"
  },
  {
    "id": "comment-thread-action-footer",
    "label": "Comment Thread Action Footer",
    "sourcePath": "packages/design-system/components/ui/comment-thread-action-footer.tsx",
    "level": "Composites",
    "pathSegments": [
      "Documents"
    ],
    "storyId": "comment-thread-action-footer",
    "storyTitle": "Composites v1.0/Documents/Comment Thread Action Footer"
  },
  {
    "id": "feed-rail",
    "label": "Feed Rail",
    "sourcePath": "packages/design-system/components/ui/feed-rail.tsx",
    "level": "Composites",
    "pathSegments": [
      "Documents"
    ],
    "storyId": "feed-rail",
    "storyTitle": "Composites v1.0/Documents/Feed Rail"
  },
  {
    "id": "inline-edit-editor-shell",
    "label": "Inline Edit Editor Shell",
    "sourcePath": "packages/design-system/components/ui/inline-edit-editor-shell.tsx",
    "level": "Composites",
    "pathSegments": [
      "Documents"
    ],
    "storyId": "inline-edit-editor-shell",
    "storyTitle": "Composites v1.0/Documents/Inline Edit Editor Shell"
  },
  {
    "id": "status-icon",
    "label": "Status Icon",
    "sourcePath": "packages/design-system/components/ui/status-icon.tsx",
    "level": "Composites",
    "pathSegments": [
      "Feedback & Status"
    ],
    "storyId": "status-icon",
    "storyTitle": "Composites v1.0/Feedback & Status/Status Icon"
  },
  {
    "id": "status-icon-primitives",
    "label": "Status Icon Primitives",
    "sourcePath": "packages/design-system/components/ui/status-icon-primitives.tsx",
    "level": "Composites",
    "pathSegments": [
      "Feedback & Status"
    ],
    "storyId": "status-icon-primitives",
    "storyTitle": "Composites v1.0/Feedback & Status/Status Icon Primitives"
  },
  {
    "id": "status-metadata-section",
    "label": "Status Metadata Section",
    "sourcePath": "packages/design-system/components/ui/status-metadata-section.tsx",
    "level": "Composites",
    "pathSegments": [
      "Feedback & Status"
    ],
    "storyId": "status-metadata-section",
    "storyTitle": "Composites v1.0/Feedback & Status/Status Metadata Section"
  },
  {
    "id": "status-percentage-icon",
    "label": "Status Percentage Icon",
    "sourcePath": "packages/design-system/components/ui/status-percentage-icon.tsx",
    "level": "Composites",
    "pathSegments": [
      "Feedback & Status"
    ],
    "storyId": "status-percentage-icon",
    "storyTitle": "Composites v1.0/Feedback & Status/Status Percentage Icon"
  },
  {
    "id": "tone-label",
    "label": "Tone Label",
    "sourcePath": "packages/design-system/components/ui/tone-label.tsx",
    "level": "Composites",
    "pathSegments": [
      "Feedback & Status"
    ],
    "storyId": "tone-label",
    "storyTitle": "Composites v1.0/Feedback & Status/Tone Label"
  },
  {
    "id": "active-filters-bar",
    "label": "Active Filters Bar",
    "sourcePath": "packages/design-system/components/ui/active-filters-bar.tsx",
    "level": "Composites",
    "pathSegments": [
      "Inputs"
    ],
    "storyId": "active-filters-bar",
    "storyTitle": "Composites v1.0/Inputs/Active Filters Bar"
  },
  {
    "id": "active-filters-bar-v2",
    "label": "Active Filters Bar V2",
    "sourcePath": "packages/design-system/components/ui/active-filters-bar-v2.tsx",
    "level": "Composites",
    "pathSegments": [
      "Inputs"
    ],
    "storyStatus": "catalog-only",
    "storyTitle": "Composites v1.0/Inputs/Active Filters Bar V2"
  },
  {
    "id": "date-picker-popover",
    "label": "Date Picker Popover",
    "sourcePath": "packages/design-system/components/ui/date-picker-popover.tsx",
    "level": "Composites",
    "pathSegments": [
      "Inputs"
    ],
    "storyId": "date-picker-popover",
    "storyTitle": "Composites v1.0/Inputs/Date Picker Popover"
  },
  {
    "id": "filter-popover",
    "label": "Filter Popover",
    "sourcePath": "packages/design-system/components/ui/filter-popover.tsx",
    "level": "Composites",
    "pathSegments": [
      "Inputs"
    ],
    "storyId": "filter-popover",
    "storyTitle": "Composites v1.0/Inputs/Filter Popover"
  },
  {
    "id": "filter-popover-v2",
    "label": "Filter Popover V2",
    "sourcePath": "packages/design-system/components/ui/filter-popover-v2.tsx",
    "level": "Composites",
    "pathSegments": [
      "Inputs"
    ],
    "storyStatus": "catalog-only",
    "storyTitle": "Composites v1.0/Inputs/Filter Popover V2"
  },
  {
    "id": "filter-range-submenu",
    "label": "Filter Range Submenu",
    "sourcePath": "packages/design-system/components/ui/filter-range-submenu.tsx",
    "level": "Composites",
    "pathSegments": [
      "Inputs"
    ],
    "storyStatus": "catalog-only",
    "storyTitle": "Composites v1.0/Inputs/Filter Range Submenu"
  },
  {
    "id": "filter-range-submenu-v2",
    "label": "Filter Range Submenu V2",
    "sourcePath": "packages/design-system/components/ui/filter-range-submenu-v2.tsx",
    "level": "Composites",
    "pathSegments": [
      "Inputs"
    ],
    "storyStatus": "catalog-only",
    "storyTitle": "Composites v1.0/Inputs/Filter Range Submenu V2"
  },
  {
    "id": "user-select-popover",
    "label": "User Select Popover",
    "sourcePath": "packages/design-system/components/ui/user-select-popover.tsx",
    "level": "Composites",
    "pathSegments": [
      "Inputs"
    ],
    "storyId": "user-select-popover",
    "storyTitle": "Composites v1.0/Inputs/User Select Popover"
  },
  {
    "id": "collapsible-section",
    "label": "Collapsible Section",
    "sourcePath": "packages/design-system/components/ui/collapsible-section.tsx",
    "level": "Composites",
    "pathSegments": [
      "Layout"
    ],
    "storyId": "collapsible-section",
    "storyTitle": "Composites v1.0/Layout/Collapsible Section"
  },
  {
    "id": "kanban-board",
    "label": "Kanban Board",
    "sourcePath": "packages/design-system/components/ui/layout/kanban-board.tsx",
    "level": "Composites",
    "pathSegments": [
      "Layout"
    ],
    "storyId": "kanban-board",
    "storyTitle": "Composites v1.0/Layout/Kanban Board"
  },
  {
    "id": "resizable",
    "label": "Resizable Panel Group",
    "sourcePath": "packages/design-system/components/ui/resizable.tsx",
    "level": "Composites",
    "pathSegments": [
      "Layout"
    ],
    "storyId": "resizable",
    "storyTitle": "Composites v1.0/Layout/Resizable Panel Group"
  },
  {
    "id": "mode-toggle",
    "label": "Mode Toggle",
    "sourcePath": "packages/design-system/components/ui/mode-toggle.tsx",
    "level": "Composites",
    "pathSegments": [
      "Navigation"
    ],
    "storyId": "mode-toggle",
    "storyTitle": "Composites v1.0/Navigation/Mode Toggle"
  },
  {
    "id": "sidebar",
    "label": "Sidebar",
    "sourcePath": "packages/design-system/components/ui/sidebar.tsx",
    "level": "Composites",
    "pathSegments": [
      "Navigation"
    ],
    "storyId": "sidebar",
    "storyTitle": "Composites v1.0/Navigation/Sidebar"
  },
  {
    "id": "sidebar-collapsible-section",
    "label": "Sidebar Collapsible Section",
    "sourcePath": "packages/design-system/components/ui/sidebar-collapsible-section.tsx",
    "level": "Composites",
    "pathSegments": [
      "Navigation"
    ],
    "storyId": "sidebar-collapsible-section",
    "storyTitle": "Composites v1.0/Navigation/Sidebar Collapsible Section"
  },
  {
    "id": "theme-submenu",
    "label": "Theme Submenu",
    "sourcePath": "packages/design-system/components/ui/theme-submenu.tsx",
    "level": "Composites",
    "pathSegments": [
      "Navigation"
    ],
    "storyId": "theme-submenu",
    "storyTitle": "Composites v1.0/Navigation/Theme Submenu"
  },
  {
    "id": "grid-table-v2-narrow-list",
    "label": "Grid Table Grouped Sections",
    "sourcePath": "packages/design-system/components/ui/grid-table-v2.tsx",
    "level": "Composites",
    "pathSegments": [
      "Shared",
      "Artifact List"
    ],
    "storyId": "grid-table-grouped-sections",
    "version": "v2.0",
    "storyTitle": "Composites/Shared/Artifact List/Grid Table Grouped Sections"
  },
  {
    "id": "inline-name-cell",
    "label": "Inline Name Cell",
    "sourcePath": "packages/design-system/components/ui/inline-name-cell.tsx",
    "level": "Composites",
    "pathSegments": [
      "Shared",
      "Artifact List"
    ],
    "storyId": "inline-name-cell",
    "version": "v2.0",
    "storyTitle": "Composites/Shared/Artifact List/Inline Name Cell"
  },
  {
    "id": "inline-reference-cell",
    "label": "Inline Reference Cell",
    "sourcePath": "packages/design-system/components/ui/inline-reference-cell.tsx",
    "level": "Composites",
    "pathSegments": [
      "Shared",
      "Artifact List"
    ],
    "storyId": "inline-reference-cell",
    "version": "v2.0",
    "storyTitle": "Composites/Shared/Artifact List/Inline Reference Cell"
  },
  {
    "id": "inline-tag-cell",
    "label": "Inline Tag Cell",
    "sourcePath": "packages/design-system/components/ui/inline-tag-cell.tsx",
    "level": "Composites",
    "pathSegments": [
      "Shared",
      "Artifact List"
    ],
    "storyId": "inline-tag-cell",
    "version": "v2.0",
    "storyTitle": "Composites/Shared/Artifact List/Inline Tag Cell"
  },
  {
    "id": "button",
    "label": "Button",
    "sourcePath": "packages/design-system/components/ui/button.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Actions"
    ],
    "storyId": "button",
    "storyTitle": "Primitives v1.0/Actions/Button"
  },
  {
    "id": "copy-button",
    "label": "Copy Button",
    "sourcePath": "packages/design-system/components/ui/primitives/copy-button.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Actions"
    ],
    "storyId": "copy-button",
    "storyTitle": "Primitives v1.0/Actions/Copy Button"
  },
  {
    "id": "favorite-button",
    "label": "Favorite Button",
    "sourcePath": "packages/design-system/components/ui/favorite-button.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Actions"
    ],
    "storyId": "favorite-button",
    "storyTitle": "Primitives v1.0/Actions/Favorite Button"
  },
  {
    "id": "chart",
    "label": "Chart",
    "sourcePath": "packages/design-system/components/ui/chart.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Charts"
    ],
    "storyId": "chart",
    "storyTitle": "Primitives v1.0/Charts/Chart"
  },
  {
    "id": "donut-slice-textures",
    "label": "Donut Slice Textures",
    "sourcePath": "packages/design-system/components/ui/donut-slice-textures.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Charts"
    ],
    "storyStatus": "catalog-only",
    "storyTitle": "Primitives v1.0/Charts/Donut Slice Textures"
  },
  {
    "id": "graph",
    "label": "Graph",
    "sourcePath": "packages/design-system/components/ui/primitives/graph.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Charts"
    ],
    "storyId": "graph",
    "storyTitle": "Primitives v1.0/Charts/Graph"
  },
  {
    "id": "ranked-bar",
    "label": "Ranked Bar",
    "sourcePath": "packages/design-system/components/ui/primitives/ranked-bar.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Charts"
    ],
    "storyId": "ranked-bar",
    "storyTitle": "Primitives v1.0/Charts/Ranked Bar"
  },
  {
    "id": "segmented-bar",
    "label": "Segmented Bar",
    "sourcePath": "packages/design-system/components/ui/primitives/segmented-bar.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Charts"
    ],
    "storyId": "segmented-bar",
    "storyTitle": "Primitives v1.0/Charts/Segmented Bar"
  },
  {
    "id": "sparkline",
    "label": "Sparkline",
    "sourcePath": "packages/design-system/components/ui/primitives/sparkline.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Charts"
    ],
    "storyId": "sparkline",
    "storyTitle": "Primitives v1.0/Charts/Sparkline"
  },
  {
    "id": "brand-icons",
    "label": "Brand Icons",
    "sourcePath": "packages/design-system/components/ui/brand-icons.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Content"
    ],
    "storyId": "brand-icons",
    "storyTitle": "Primitives v1.0/Content/Brand Icons"
  },
  {
    "id": "unified-diff",
    "label": "Unified Diff",
    "sourcePath": "packages/design-system/components/ui/primitives/unified-diff.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Content"
    ],
    "storyId": "unified-diff",
    "storyTitle": "Primitives v1.0/Content/Unified Diff"
  },
  {
    "id": "avatar",
    "label": "Avatar",
    "sourcePath": "packages/design-system/components/ui/avatar.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "avatar",
    "storyTitle": "Primitives v1.0/Data Display/Avatar"
  },
  {
    "id": "avatar-primitive",
    "label": "Avatar",
    "sourcePath": "packages/design-system/components/ui/person-avatar.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "avatar-primitive",
    "version": "v2.0",
    "storyTitle": "Primitives/Data Display/Avatar"
  },
  {
    "id": "badge",
    "label": "Badge",
    "sourcePath": "packages/design-system/components/ui/badge.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "badge",
    "storyTitle": "Primitives v1.0/Data Display/Badge"
  },
  {
    "id": "chip",
    "label": "Chip",
    "sourcePath": "packages/design-system/components/ui/chip.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "chip",
    "storyTitle": "Primitives v1.0/Data Display/Chip"
  },
  {
    "id": "drag-preview-chip",
    "label": "Drag Preview Chip",
    "sourcePath": "packages/design-system/components/ui/drag-preview-chip.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "drag-preview-chip",
    "version": "v2.0",
    "storyTitle": "Primitives/Data Display/Drag Preview Chip"
  },
  {
    "id": "grid-interaction-contract",
    "label": "Grid Interaction Contract",
    "sourcePath": "packages/design-system/components/ui/grid-interaction-contract.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "grid-interaction-contract",
    "version": "v2.0",
    "storyTitle": "Primitives/Data Display/Grid Interaction Contract"
  },
  {
    "id": "grid-row-drag-handle",
    "label": "Grid Row Drag Handle",
    "sourcePath": "packages/design-system/components/ui/grid-row-drag-handle.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "grid-row-drag-handle",
    "version": "v2.0",
    "storyTitle": "Primitives/Data Display/Grid Row Drag Handle"
  },
  {
    "id": "group-section-header",
    "label": "Group Section Header",
    "sourcePath": "packages/design-system/components/ui/group-section-header.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "group-section-header",
    "storyTitle": "Primitives v1.0/Data Display/Group Section Header"
  },
  {
    "id": "metric-card-lane",
    "label": "Metric Card Lane",
    "sourcePath": "packages/design-system/components/ui/primitives/metric-card-lane.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Data Display"
    ],
    "storyStatus": "catalog-only",
    "storyTitle": "Primitives v1.0/Data Display/Metric Card Lane"
  },
  {
    "id": "move-between-sections-icon",
    "label": "Move Between Sections Icon",
    "sourcePath": "packages/design-system/components/ui/move-between-sections-icon.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "move-between-sections-icon",
    "storyTitle": "Primitives v1.0/Data Display/Move Between Sections Icon"
  },
  {
    "id": "person-avatar",
    "label": "Person Avatar",
    "sourcePath": "packages/design-system/components/ui/person-avatar.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Data Display"
    ],
    "storyStatus": "catalog-only",
    "storyTitle": "Primitives v1.0/Data Display/Person Avatar"
  },
  {
    "id": "section-header",
    "label": "Section Header",
    "sourcePath": "packages/design-system/components/ui/section-header.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "section-header",
    "storyTitle": "Primitives v1.0/Data Display/Section Header"
  },
  {
    "id": "sortable-column-header",
    "label": "Sortable Column Header",
    "sourcePath": "packages/design-system/components/ui/sortable-column-header.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "sortable-column-header",
    "storyTitle": "Primitives v1.0/Data Display/Sortable Column Header"
  },
  {
    "id": "sortable-subtree",
    "label": "Sortable Subtree",
    "sourcePath": "packages/design-system/components/ui/sortable-subtree.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "sortable-subtree",
    "version": "v2.0",
    "storyTitle": "Primitives/Data Display/Sortable Subtree"
  },
  {
    "id": "grid-table-list-surface",
    "label": "Grid Table List Surface",
    "sourcePath": "packages/design-system/components/ui/grid-table-list-surface.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Data Display",
      "Tables"
    ],
    "storyId": "grid-table-list-surface",
    "storyTitle": "Primitives v1.0/Data Display/Tables/Grid Table List Surface"
  },
  {
    "id": "grid-table-v2-cell",
    "label": "Grid Table V2 Cell",
    "sourcePath": "packages/design-system/components/ui/grid-table-v2-cell.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Data Display",
      "Tables"
    ],
    "storyId": "grid-table-v2-cell",
    "storyTitle": "Primitives v1.0/Data Display/Tables/Grid Table V2 Cell"
  },
  {
    "id": "grid-table-v2-frame",
    "label": "Grid Table V2 Frame",
    "sourcePath": "packages/design-system/components/ui/grid-table-v2-frame.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Data Display",
      "Tables"
    ],
    "storyStatus": "catalog-only",
    "storyTitle": "Primitives v1.0/Data Display/Tables/Grid Table V2 Frame"
  },
  {
    "id": "grid-table-v2-tree-lead",
    "label": "Grid Table V2 Tree Lead",
    "sourcePath": "packages/design-system/components/ui/grid-table-v2-tree-lead.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Data Display",
      "Tables"
    ],
    "storyId": "grid-table-v2-tree-lead",
    "storyTitle": "Primitives v1.0/Data Display/Tables/Grid Table V2 Tree Lead"
  },
  {
    "id": "table",
    "label": "Table",
    "sourcePath": "packages/design-system/components/ui/table.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Data Display",
      "Tables"
    ],
    "storyId": "table",
    "storyTitle": "Primitives v1.0/Data Display/Tables/Table"
  },
  {
    "id": "table-pagination",
    "label": "Table Pagination",
    "sourcePath": "packages/design-system/components/ui/table-pagination.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Data Display",
      "Tables"
    ],
    "storyId": "table-pagination",
    "storyTitle": "Primitives v1.0/Data Display/Tables/Table Pagination"
  },
  {
    "id": "alert",
    "label": "Alert",
    "sourcePath": "packages/design-system/components/ui/alert.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Feedback & Status"
    ],
    "storyId": "alert",
    "storyTitle": "Primitives v1.0/Feedback & Status/Alert"
  },
  {
    "id": "empty-state",
    "label": "Empty State",
    "sourcePath": "packages/design-system/components/ui/empty-state.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Feedback & Status"
    ],
    "storyId": "empty-state",
    "storyTitle": "Primitives v1.0/Feedback & Status/Empty State"
  },
  {
    "id": "inline-edit-feedback",
    "label": "Inline Edit Feedback",
    "sourcePath": "packages/design-system/components/ui/inline-edit-feedback.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Feedback & Status"
    ],
    "storyId": "inline-edit-feedback",
    "version": "v2.0",
    "storyTitle": "Primitives/Feedback & Status/Inline Edit Feedback"
  },
  {
    "id": "priority-badge",
    "label": "Priority Badge",
    "sourcePath": "packages/design-system/components/ui/priority-badge.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Feedback & Status"
    ],
    "storyId": "priority-badge",
    "storyTitle": "Primitives v1.0/Feedback & Status/Priority Badge"
  },
  {
    "id": "priority-icon",
    "label": "Priority Icon",
    "sourcePath": "packages/design-system/components/ui/priority-icon.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Feedback & Status"
    ],
    "storyId": "priority-icon",
    "storyTitle": "Primitives v1.0/Feedback & Status/Priority Icon"
  },
  {
    "id": "progress",
    "label": "Progress",
    "sourcePath": "packages/design-system/components/ui/progress.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Feedback & Status"
    ],
    "storyId": "progress",
    "storyTitle": "Primitives v1.0/Feedback & Status/Progress"
  },
  {
    "id": "skeleton",
    "label": "Skeleton",
    "sourcePath": "packages/design-system/components/ui/skeleton.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Feedback & Status"
    ],
    "storyId": "skeleton",
    "storyTitle": "Primitives v1.0/Feedback & Status/Skeleton"
  },
  {
    "id": "sonner",
    "label": "Sonner",
    "sourcePath": "packages/design-system/components/ui/sonner.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Feedback & Status"
    ],
    "storyId": "sonner",
    "storyTitle": "Primitives v1.0/Feedback & Status/Sonner"
  },
  {
    "id": "status-badge",
    "label": "Status Badge",
    "sourcePath": "packages/design-system/components/ui/primitives/status-badge.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Feedback & Status"
    ],
    "storyId": "status-badge",
    "storyTitle": "Primitives v1.0/Feedback & Status/Status Badge"
  },
  {
    "id": "calendar",
    "label": "Calendar",
    "sourcePath": "packages/design-system/components/ui/calendar.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Inputs"
    ],
    "storyId": "calendar",
    "storyTitle": "Primitives v1.0/Inputs/Calendar"
  },
  {
    "id": "checkbox",
    "label": "Checkbox",
    "sourcePath": "packages/design-system/components/ui/checkbox.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Inputs"
    ],
    "storyId": "checkbox",
    "storyTitle": "Primitives v1.0/Inputs/Checkbox"
  },
  {
    "id": "checkbox-tree",
    "label": "Checkbox Tree",
    "sourcePath": "packages/design-system/components/ui/checkbox-tree.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Inputs"
    ],
    "storyId": "checkbox-tree",
    "version": "v2.0",
    "storyTitle": "Primitives/Inputs/Checkbox Tree"
  },
  {
    "id": "command",
    "label": "Command",
    "sourcePath": "packages/design-system/components/ui/command.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Inputs"
    ],
    "storyId": "command",
    "storyTitle": "Primitives v1.0/Inputs/Command"
  },
  {
    "id": "filter-chip",
    "label": "Filter Chip",
    "sourcePath": "packages/design-system/components/ui/filter-chip.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Inputs"
    ],
    "storyId": "filter-chip",
    "storyTitle": "Primitives v1.0/Inputs/Filter Chip"
  },
  {
    "id": "form",
    "label": "Form",
    "sourcePath": "packages/design-system/components/ui/form.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Inputs"
    ],
    "storyId": "form",
    "storyTitle": "Primitives v1.0/Inputs/Form"
  },
  {
    "id": "input",
    "label": "Input",
    "sourcePath": "packages/design-system/components/ui/input.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Inputs"
    ],
    "storyId": "input",
    "storyTitle": "Primitives v1.0/Inputs/Input"
  },
  {
    "id": "label",
    "label": "Label",
    "sourcePath": "packages/design-system/components/ui/label.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Inputs"
    ],
    "storyId": "label",
    "storyTitle": "Primitives v1.0/Inputs/Label"
  },
  {
    "id": "radio-group",
    "label": "Radio Group",
    "sourcePath": "packages/design-system/components/ui/radio-group.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Inputs"
    ],
    "storyId": "radio-group",
    "storyTitle": "Primitives v1.0/Inputs/Radio Group"
  },
  {
    "id": "select",
    "label": "Select",
    "sourcePath": "packages/design-system/components/ui/select.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Inputs"
    ],
    "storyId": "select",
    "storyTitle": "Primitives v1.0/Inputs/Select"
  },
  {
    "id": "switch",
    "label": "Switch",
    "sourcePath": "packages/design-system/components/ui/switch.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Inputs"
    ],
    "storyId": "switch",
    "storyTitle": "Primitives v1.0/Inputs/Switch"
  },
  {
    "id": "textarea",
    "label": "Textarea",
    "sourcePath": "packages/design-system/components/ui/textarea.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Inputs"
    ],
    "storyId": "textarea",
    "storyTitle": "Primitives v1.0/Inputs/Textarea"
  },
  {
    "id": "toggle",
    "label": "Toggle",
    "sourcePath": "packages/design-system/components/ui/toggle.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Inputs"
    ],
    "storyId": "toggle",
    "storyTitle": "Primitives v1.0/Inputs/Toggle"
  },
  {
    "id": "toggle-group",
    "label": "Toggle Group",
    "sourcePath": "packages/design-system/components/ui/toggle-group.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Inputs"
    ],
    "storyId": "toggle-group",
    "storyTitle": "Primitives v1.0/Inputs/Toggle Group"
  },
  {
    "id": "card",
    "label": "Card",
    "sourcePath": "packages/design-system/components/ui/card.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Layout"
    ],
    "storyId": "card",
    "storyTitle": "Primitives v1.0/Layout/Card"
  },
  {
    "id": "collapsible",
    "label": "Collapsible",
    "sourcePath": "packages/design-system/components/ui/collapsible.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Layout"
    ],
    "storyId": "collapsible",
    "storyTitle": "Primitives v1.0/Layout/Collapsible"
  },
  {
    "id": "scroll-area",
    "label": "Scroll Area",
    "sourcePath": "packages/design-system/components/ui/scroll-area.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Layout"
    ],
    "storyId": "scroll-area",
    "storyTitle": "Primitives v1.0/Layout/Scroll Area"
  },
  {
    "id": "section",
    "label": "Section",
    "sourcePath": "packages/design-system/components/ui/layout/section.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Layout"
    ],
    "storyId": "section",
    "storyTitle": "Primitives v1.0/Layout/Section"
  },
  {
    "id": "separator",
    "label": "Separator",
    "sourcePath": "packages/design-system/components/ui/separator.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Layout"
    ],
    "storyId": "separator",
    "storyTitle": "Primitives v1.0/Layout/Separator"
  },
  {
    "id": "breadcrumb",
    "label": "Breadcrumb",
    "sourcePath": "packages/design-system/components/ui/breadcrumb.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Navigation"
    ],
    "storyId": "breadcrumb",
    "storyTitle": "Primitives v1.0/Navigation/Breadcrumb"
  },
  {
    "id": "sidebar-count-badge",
    "label": "Sidebar Count Badge",
    "sourcePath": "packages/design-system/components/ui/sidebar-count-badge.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Navigation"
    ],
    "storyId": "sidebar-count-badge",
    "storyTitle": "Primitives v1.0/Navigation/Sidebar Count Badge"
  },
  {
    "id": "tabs",
    "label": "Tabs",
    "sourcePath": "packages/design-system/components/ui/tabs.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Navigation"
    ],
    "storyId": "tabs",
    "storyTitle": "Primitives v1.0/Navigation/Tabs"
  },
  {
    "id": "underline-tabs",
    "label": "Underline Tabs",
    "sourcePath": "packages/design-system/components/ui/primitives/underline-tabs.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Navigation"
    ],
    "storyId": "underline-tabs",
    "storyTitle": "Primitives v1.0/Navigation/Underline Tabs"
  },
  {
    "id": "alert-dialog",
    "label": "Alert Dialog",
    "sourcePath": "packages/design-system/components/ui/alert-dialog.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Overlays"
    ],
    "storyId": "alert-dialog",
    "storyTitle": "Primitives v1.0/Overlays/Alert Dialog"
  },
  {
    "id": "dialog",
    "label": "Dialog",
    "sourcePath": "packages/design-system/components/ui/dialog.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Overlays"
    ],
    "storyId": "dialog",
    "storyTitle": "Primitives v1.0/Overlays/Dialog"
  },
  {
    "id": "drawer",
    "label": "Drawer",
    "sourcePath": "packages/design-system/components/ui/drawer.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Overlays"
    ],
    "storyId": "drawer",
    "storyTitle": "Primitives v1.0/Overlays/Drawer"
  },
  {
    "id": "dropdown-menu",
    "label": "Dropdown Menu",
    "sourcePath": "packages/design-system/components/ui/dropdown-menu.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Overlays"
    ],
    "storyId": "dropdown-menu",
    "storyTitle": "Primitives v1.0/Overlays/Dropdown Menu"
  },
  {
    "id": "grid-table-v2-tooltip",
    "label": "Grid Table V2 Tooltip",
    "sourcePath": "packages/design-system/components/ui/grid-table-v2-tooltip.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Overlays"
    ],
    "storyId": "grid-table-v2-tooltip",
    "storyTitle": "Primitives v1.0/Overlays/Grid Table V2 Tooltip"
  },
  {
    "id": "info-hint",
    "label": "Info Hint",
    "sourcePath": "packages/design-system/components/ui/primitives/info-hint.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Overlays"
    ],
    "storyId": "info-hint",
    "storyTitle": "Primitives v1.0/Overlays/Info Hint"
  },
  {
    "id": "popover",
    "label": "Popover",
    "sourcePath": "packages/design-system/components/ui/popover.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Overlays"
    ],
    "storyId": "popover",
    "storyTitle": "Primitives v1.0/Overlays/Popover"
  },
  {
    "id": "sheet",
    "label": "Sheet",
    "sourcePath": "packages/design-system/components/ui/sheet.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Overlays"
    ],
    "storyId": "sheet",
    "storyTitle": "Primitives v1.0/Overlays/Sheet"
  },
  {
    "id": "tooltip",
    "label": "Tooltip",
    "sourcePath": "packages/design-system/components/ui/tooltip.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Overlays"
    ],
    "storyId": "tooltip",
    "storyTitle": "Primitives v1.0/Overlays/Tooltip"
  }
] as const satisfies readonly StorybookCatalogEntry[];

export const appComponentCatalog =
  [
  {
    "id": "confirmation-dialog",
    "label": "Confirmation Dialog",
    "sourcePath": "packages/app/shared/components/confirmation-dialog.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Overlays"
    ],
    "storyId": "confirmation-dialog",
    "storyTitle": "Primitives v1.0/Overlays/Confirmation Dialog"
  },
  {
    "id": "delete-confirmation-dialog",
    "label": "Delete Confirmation Dialog",
    "sourcePath": "packages/app/shared/components/delete-confirmation-dialog.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Overlays"
    ],
    "storyId": "delete-confirmation-dialog",
    "storyTitle": "Primitives v1.0/Overlays/Delete Confirmation Dialog"
  },
  {
    "id": "page-loading-spinner",
    "label": "Page Loading Spinner",
    "sourcePath": "packages/app/shared/components/page-loading-spinner.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Feedback & Status"
    ],
    "storyId": "page-loading-spinner",
    "storyTitle": "Primitives v1.0/Feedback & Status/Page Loading Spinner"
  },
  {
    "id": "list-surface-toolbar-v2",
    "label": "Filtering and Sorting Model",
    "sourcePath": "packages/app/shared/components/list-surface-toolbar-v2.tsx",
    "level": "Composites",
    "pathSegments": [
      "Shared",
      "Artifact List"
    ],
    "storyId": "filtering-and-sorting-model",
    "version": "v2.0",
    "storyTitle": "Composites/Shared/Artifact List/Filtering and Sorting Model"
  },
  {
    "id": "sidebar-nav-link-item",
    "label": "Sidebar Nav Link Item",
    "sourcePath": "packages/design-system/components/ui/sidebar.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Navigation"
    ],
    "storyId": "sidebar-nav-link-item",
    "storyTitle": "Primitives v1.0/Navigation/Sidebar Nav Link Item"
  },
  {
    "id": "sidebar-section-header",
    "label": "Sidebar Section Header",
    "sourcePath": "packages/design-system/components/ui/sidebar.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Navigation"
    ],
    "storyId": "sidebar-section-header",
    "storyTitle": "Primitives v1.0/Navigation/Sidebar Section Header"
  }
] as const satisfies readonly StorybookCatalogEntry[];

export const appCoreComponentCatalog =
  [
  {
    "id": "activity-bucket-tooltip",
    "label": "Activity Bucket Tooltip",
    "sourcePath": "packages/app/agents/components/detail/activity-bucket-tooltip.tsx",
    "level": "Composites",
    "pathSegments": [
      "Agents",
      "Detail"
    ],
    "storyId": "activity-bucket-tooltip",
    "storyTitle": "Composites v1.0/Agents/Detail/Activity Bucket Tooltip"
  },
  {
    "id": "agent-orchestration-graph",
    "label": "Agent Orchestration Graph",
    "sourcePath": "packages/app/agents/components/detail/agent-orchestration-graph.tsx",
    "level": "Composites",
    "pathSegments": [
      "Agents",
      "Detail"
    ],
    "storyId": "agent-orchestration-graph",
    "storyTitle": "Composites v1.0/Agents/Detail/Agent Orchestration Graph"
  },
  {
    "id": "agent-session-detail-analytics-tabs",
    "label": "Agent Session Detail Analytics Tabs",
    "sourcePath": "packages/app/agents/components/detail/agent-session-detail-analytics-tabs.tsx",
    "level": "Composites",
    "pathSegments": [
      "Agents",
      "Detail"
    ],
    "storyId": "agent-session-detail-analytics-tabs",
    "storyTitle": "Composites v1.0/Agents/Detail/Agent Session Detail Analytics Tabs"
  },
  {
    "id": "agent-session-detail-states",
    "label": "Agent Session Detail States",
    "sourcePath": "packages/app/agents/components/detail/agent-session-detail-states.tsx",
    "level": "Composites",
    "pathSegments": [
      "Agents",
      "Detail"
    ],
    "storyId": "agent-session-detail-states",
    "storyTitle": "Composites v1.0/Agents/Detail/Agent Session Detail States"
  },
  {
    "id": "error-propagation-map",
    "label": "Error Propagation Map",
    "sourcePath": "packages/app/agents/components/detail/error-propagation-map.tsx",
    "level": "Composites",
    "pathSegments": [
      "Agents",
      "Detail"
    ],
    "storyId": "error-propagation-map",
    "storyTitle": "Composites v1.0/Agents/Detail/Error Propagation Map"
  },
  {
    "id": "property-values",
    "label": "Property Values",
    "sourcePath": "packages/app/agents/components/detail/property-values.tsx",
    "level": "Composites",
    "pathSegments": [
      "Agents",
      "Detail"
    ],
    "storyId": "property-values",
    "storyTitle": "Composites v1.0/Agents/Detail/Property Values"
  },
  {
    "id": "session-comments-pane",
    "label": "Session Comments Pane",
    "sourcePath": "packages/app/agents/components/detail/session-comments-pane.tsx",
    "level": "Composites",
    "pathSegments": [
      "Agents",
      "Detail"
    ],
    "storyId": "session-comments-pane",
    "storyTitle": "Composites v1.0/Agents/Detail/Session Comments Pane"
  },
  {
    "id": "session-detail-panels",
    "label": "Session Detail Panels",
    "sourcePath": "packages/app/agents/components/detail/session-detail-panels.tsx",
    "level": "Composites",
    "pathSegments": [
      "Agents",
      "Detail"
    ],
    "storyId": "session-detail-panels",
    "storyTitle": "Composites v1.0/Agents/Detail/Session Detail Panels"
  },
  {
    "id": "session-duration-property",
    "label": "Session Duration Property",
    "sourcePath": "packages/app/agents/components/detail/session-duration-property.tsx",
    "level": "Composites",
    "pathSegments": [
      "Agents",
      "Detail"
    ],
    "storyId": "session-duration-property",
    "storyTitle": "Composites v1.0/Agents/Detail/Session Duration Property"
  },
  {
    "id": "session-flagged-properties",
    "label": "Session Flagged Properties",
    "sourcePath": "packages/app/agents/components/detail/session-flagged-properties.tsx",
    "level": "Composites",
    "pathSegments": [
      "Agents",
      "Detail"
    ],
    "storyId": "session-flagged-properties",
    "storyTitle": "Composites v1.0/Agents/Detail/Session Flagged Properties"
  },
  {
    "id": "session-linked-artifacts-row",
    "label": "Session Linked Artifacts Row",
    "sourcePath": "packages/app/agents/components/detail/session-linked-artifacts-row.tsx",
    "level": "Composites",
    "pathSegments": [
      "Agents",
      "Detail"
    ],
    "storyId": "session-linked-artifacts-row",
    "storyTitle": "Composites v1.0/Agents/Detail/Session Linked Artifacts Row"
  },
  {
    "id": "session-measured-properties",
    "label": "Session Measured Properties",
    "sourcePath": "packages/app/agents/components/detail/session-measured-properties.tsx",
    "level": "Composites",
    "pathSegments": [
      "Agents",
      "Detail"
    ],
    "storyId": "session-measured-properties",
    "storyTitle": "Composites v1.0/Agents/Detail/Session Measured Properties"
  },
  {
    "id": "session-properties-panel",
    "label": "Session Properties Panel",
    "sourcePath": "packages/app/agents/components/detail/session-properties-panel.tsx",
    "level": "Composites",
    "pathSegments": [
      "Agents",
      "Detail"
    ],
    "storyId": "session-properties-panel",
    "storyTitle": "Composites v1.0/Agents/Detail/Session Properties Panel"
  },
  {
    "id": "session-pull-request-pill",
    "label": "Session Pull Request Pill",
    "sourcePath": "packages/app/agents/components/detail/session-pull-request-pill.tsx",
    "level": "Composites",
    "pathSegments": [
      "Agents",
      "Detail"
    ],
    "storyId": "session-pull-request-pill",
    "storyTitle": "Composites v1.0/Agents/Detail/Session Pull Request Pill"
  },
  {
    "id": "session-timeline-axis",
    "label": "Session Timeline Axis",
    "sourcePath": "packages/app/agents/components/detail/session-timeline-axis.tsx",
    "level": "Composites",
    "pathSegments": [
      "Agents",
      "Detail"
    ],
    "storyId": "session-timeline-axis",
    "storyTitle": "Composites v1.0/Agents/Detail/Session Timeline Axis"
  },
  {
    "id": "session-timeline-bar-labels",
    "label": "Session Timeline Bar Labels",
    "sourcePath": "packages/app/agents/components/detail/session-timeline-bar-labels.tsx",
    "level": "Composites",
    "pathSegments": [
      "Agents",
      "Detail"
    ],
    "storyId": "session-timeline-bar-labels",
    "storyTitle": "Composites v1.0/Agents/Detail/Session Timeline Bar Labels"
  },
  {
    "id": "session-timeline-bars",
    "label": "Session Timeline Bars",
    "sourcePath": "packages/app/agents/components/detail/session-timeline-bars.tsx",
    "level": "Composites",
    "pathSegments": [
      "Agents",
      "Detail"
    ],
    "storyId": "session-timeline-bars",
    "storyTitle": "Composites v1.0/Agents/Detail/Session Timeline Bars"
  },
  {
    "id": "session-timeline-controls",
    "label": "Session Timeline Controls",
    "sourcePath": "packages/app/agents/components/detail/session-timeline-controls.tsx",
    "level": "Composites",
    "pathSegments": [
      "Agents",
      "Detail"
    ],
    "storyId": "session-timeline-controls",
    "storyTitle": "Composites v1.0/Agents/Detail/Session Timeline Controls"
  },
  {
    "id": "session-timeline-dot-rail",
    "label": "Session Timeline Dot Rail",
    "sourcePath": "packages/app/agents/components/detail/session-timeline-dot-rail.tsx",
    "level": "Composites",
    "pathSegments": [
      "Agents",
      "Detail"
    ],
    "storyId": "session-timeline-dot-rail",
    "storyTitle": "Composites v1.0/Agents/Detail/Session Timeline Dot Rail"
  },
  {
    "id": "session-timeline-strip-parts",
    "label": "Session Timeline Strip Parts",
    "sourcePath": "packages/app/agents/components/detail/session-timeline-strip-parts.tsx",
    "level": "Composites",
    "pathSegments": [
      "Agents",
      "Detail"
    ],
    "storyId": "session-timeline-strip-parts",
    "storyTitle": "Composites v1.0/Agents/Detail/Session Timeline Strip Parts"
  },
  {
    "id": "session-timeline-summary",
    "label": "Session Timeline Summary",
    "sourcePath": "packages/app/agents/components/detail/session-timeline-summary.tsx",
    "level": "Composites",
    "pathSegments": [
      "Agents",
      "Detail"
    ],
    "storyId": "session-timeline-summary",
    "storyTitle": "Composites v1.0/Agents/Detail/Session Timeline Summary"
  },
  {
    "id": "session-trace",
    "label": "Session Trace",
    "sourcePath": "packages/app/agents/components/detail/session-trace.tsx",
    "level": "Composites",
    "pathSegments": [
      "Agents",
      "Detail"
    ],
    "storyId": "session-trace",
    "storyTitle": "Composites v1.0/Agents/Detail/Session Trace"
  },
  {
    "id": "session-trace-subagent",
    "label": "Session Trace Subagent",
    "sourcePath": "packages/app/agents/components/detail/session-trace-subagent.tsx",
    "level": "Composites",
    "pathSegments": [
      "Agents",
      "Detail"
    ],
    "storyId": "session-trace-subagent",
    "storyTitle": "Composites v1.0/Agents/Detail/Session Trace Subagent"
  },
  {
    "id": "session-trace-tool-row-detail",
    "label": "Session Trace Tool Row Detail",
    "sourcePath": "packages/app/agents/components/detail/session-trace-tool-row-detail.tsx",
    "level": "Composites",
    "pathSegments": [
      "Agents",
      "Detail"
    ],
    "storyId": "session-trace-tool-row-detail",
    "storyTitle": "Composites v1.0/Agents/Detail/Session Trace Tool Row Detail"
  },
  {
    "id": "subagent-effectiveness-panel",
    "label": "Subagent Effectiveness Panel",
    "sourcePath": "packages/app/agents/components/detail/subagent-effectiveness-panel.tsx",
    "level": "Composites",
    "pathSegments": [
      "Agents",
      "Detail"
    ],
    "storyId": "subagent-effectiveness-panel",
    "storyTitle": "Composites v1.0/Agents/Detail/Subagent Effectiveness Panel"
  },
  {
    "id": "tool-execution-flow",
    "label": "Tool Execution Flow",
    "sourcePath": "packages/app/agents/components/detail/tool-execution-flow.tsx",
    "level": "Composites",
    "pathSegments": [
      "Agents",
      "Detail"
    ],
    "storyId": "tool-execution-flow",
    "storyTitle": "Composites v1.0/Agents/Detail/Tool Execution Flow"
  },
  {
    "id": "trace-comments-rail",
    "label": "Trace Comments Rail",
    "sourcePath": "packages/app/agents/components/detail/trace-comments-rail.tsx",
    "level": "Composites",
    "pathSegments": [
      "Agents",
      "Detail"
    ],
    "storyId": "trace-comments-rail",
    "storyTitle": "Composites v1.0/Agents/Detail/Trace Comments Rail"
  },
  {
    "id": "trace-event-row",
    "label": "Trace Event Row",
    "sourcePath": "packages/app/agents/components/detail/trace-event-row.tsx",
    "level": "Composites",
    "pathSegments": [
      "Agents",
      "Detail"
    ],
    "storyId": "trace-event-row",
    "storyTitle": "Composites v1.0/Agents/Detail/Trace Event Row"
  },
  {
    "id": "trace-harness-tags",
    "label": "Trace Harness Tags",
    "sourcePath": "packages/app/agents/components/detail/trace-harness-tags.tsx",
    "level": "Composites",
    "pathSegments": [
      "Agents",
      "Detail"
    ],
    "storyId": "trace-harness-tags",
    "storyTitle": "Composites v1.0/Agents/Detail/Trace Harness Tags"
  },
  {
    "id": "trace-markdown",
    "label": "Trace Markdown",
    "sourcePath": "packages/app/agents/components/detail/trace-markdown.tsx",
    "level": "Composites",
    "pathSegments": [
      "Agents",
      "Detail"
    ],
    "storyId": "trace-markdown",
    "storyTitle": "Composites v1.0/Agents/Detail/Trace Markdown"
  },
  {
    "id": "trace-message-body",
    "label": "Trace Message Body",
    "sourcePath": "packages/app/agents/components/detail/trace-message-body.tsx",
    "level": "Composites",
    "pathSegments": [
      "Agents",
      "Detail"
    ],
    "storyId": "trace-message-body",
    "storyTitle": "Composites v1.0/Agents/Detail/Trace Message Body"
  },
  {
    "id": "transcript-file-switcher",
    "label": "Transcript File Switcher",
    "sourcePath": "packages/app/agents/components/detail/transcript-file-switcher.tsx",
    "level": "Composites",
    "pathSegments": [
      "Agents",
      "Detail"
    ],
    "storyId": "transcript-file-switcher",
    "storyTitle": "Composites v1.0/Agents/Detail/Transcript File Switcher"
  },
  {
    "id": "transcript-force-archive-action",
    "label": "Transcript Force Archive Action",
    "sourcePath": "packages/app/agents/components/detail/transcript-force-archive-action.tsx",
    "level": "Composites",
    "pathSegments": [
      "Agents",
      "Detail"
    ],
    "storyId": "transcript-force-archive-action",
    "storyTitle": "Composites v1.0/Agents/Detail/Transcript Force Archive Action"
  },
  {
    "id": "viewport-tooltip",
    "label": "Viewport Tooltip",
    "sourcePath": "packages/app/agents/components/detail/viewport-tooltip.tsx",
    "level": "Composites",
    "pathSegments": [
      "Agents",
      "Detail"
    ],
    "storyId": "viewport-tooltip",
    "storyTitle": "Composites v1.0/Agents/Detail/Viewport Tooltip"
  },
  {
    "id": "active-runs-panel",
    "label": "Active Runs Panel",
    "sourcePath": "packages/app/agents/components/sessions/active-runs-panel.tsx",
    "level": "Composites",
    "pathSegments": [
      "Agents",
      "General"
    ],
    "storyId": "active-runs-panel",
    "storyTitle": "Composites v1.0/Agents/General/Active Runs Panel"
  },
  {
    "id": "agent-card",
    "label": "Agent Card",
    "sourcePath": "packages/app/agents/components/agent-card.tsx",
    "level": "Composites",
    "pathSegments": [
      "Agents",
      "General"
    ],
    "storyId": "agent-card",
    "storyTitle": "Composites v1.0/Agents/General/Agent Card"
  },
  {
    "id": "agent-collaboration-network",
    "label": "Agent Collaboration Network",
    "sourcePath": "packages/app/agents/components/agent-collaboration-network.tsx",
    "level": "Composites",
    "pathSegments": [
      "Agents",
      "General"
    ],
    "storyId": "agent-collaboration-network",
    "storyTitle": "Composites v1.0/Agents/General/Agent Collaboration Network"
  },
  {
    "id": "agent-compliance-settings-tab",
    "label": "Agent Compliance Settings Tab",
    "sourcePath": "packages/app/agents/components/agent-compliance-settings-tab.tsx",
    "level": "Composites",
    "pathSegments": [
      "Agents",
      "General"
    ],
    "storyId": "agent-compliance-settings-tab",
    "storyTitle": "Composites v1.0/Agents/General/Agent Compliance Settings Tab"
  },
  {
    "id": "agent-session-activity-feed",
    "label": "Agent Session Activity Feed",
    "sourcePath": "packages/app/agents/components/activity/agent-session-activity-feed.tsx",
    "level": "Composites",
    "pathSegments": [
      "Agents",
      "General"
    ],
    "storyId": "agent-session-activity-feed",
    "storyTitle": "Composites v1.0/Agents/General/Agent Session Activity Feed"
  },
  {
    "id": "agents-nav-badge",
    "label": "Agents Nav Badge",
    "sourcePath": "packages/app/agents/components/agents-nav-badge.tsx",
    "level": "Composites",
    "pathSegments": [
      "Agents",
      "General"
    ],
    "storyId": "agents-nav-badge",
    "storyTitle": "Composites v1.0/Agents/General/Agents Nav Badge"
  },
  {
    "id": "cli-tools-panel",
    "label": "CLI Tools Panel",
    "sourcePath": "packages/app/agents/components/cli-tools-panel.tsx",
    "level": "Composites",
    "pathSegments": [
      "Agents",
      "General"
    ],
    "storyId": "cli-tools-panel",
    "storyTitle": "Composites v1.0/Agents/General/CLI Tools Panel"
  },
  {
    "id": "compaction-impact",
    "label": "Compaction Impact",
    "sourcePath": "packages/app/agents/components/compaction-impact.tsx",
    "level": "Composites",
    "pathSegments": [
      "Agents",
      "General"
    ],
    "storyId": "compaction-impact",
    "storyTitle": "Composites v1.0/Agents/General/Compaction Impact"
  },
  {
    "id": "context-cards",
    "label": "Context Cards",
    "sourcePath": "packages/app/agents/components/analytics/context-cards.tsx",
    "level": "Composites",
    "pathSegments": [
      "Agents",
      "General"
    ],
    "storyId": "context-cards",
    "storyTitle": "Composites v1.0/Agents/General/Context Cards"
  },
  {
    "id": "event-group-row",
    "label": "Event Group Row",
    "sourcePath": "packages/app/agents/components/events/event-group-row.tsx",
    "level": "Composites",
    "pathSegments": [
      "Agents",
      "General"
    ],
    "storyId": "event-group-row",
    "storyTitle": "Composites v1.0/Agents/General/Event Group Row"
  },
  {
    "id": "orchestration-dag",
    "label": "Orchestration Dag",
    "sourcePath": "packages/app/agents/components/orchestration-dag.tsx",
    "level": "Composites",
    "pathSegments": [
      "Agents",
      "General"
    ],
    "storyId": "orchestration-dag",
    "storyTitle": "Composites v1.0/Agents/General/Orchestration Dag"
  },
  {
    "id": "session-status-badges",
    "label": "Session Status Badges",
    "sourcePath": "packages/app/agents/components/session-status-badges.tsx",
    "level": "Composites",
    "pathSegments": [
      "Agents",
      "General"
    ],
    "storyId": "session-status-badges",
    "storyTitle": "Composites v1.0/Agents/General/Session Status Badges"
  },
  {
    "id": "thinking-block",
    "label": "Thinking Block",
    "sourcePath": "packages/app/agents/components/thinking-block.tsx",
    "level": "Composites",
    "pathSegments": [
      "Agents",
      "General"
    ],
    "storyId": "thinking-block",
    "storyTitle": "Composites v1.0/Agents/General/Thinking Block"
  },
  {
    "id": "agent-card-header-attributes",
    "label": "Agent Card Header Attributes",
    "sourcePath": "packages/app/agents/components/workspace/agent-card-header-attributes.tsx",
    "level": "Composites",
    "pathSegments": [
      "Agents",
      "Workspace"
    ],
    "storyId": "agent-card-header-attributes",
    "storyTitle": "Composites v1.0/Agents/Workspace/Agent Card Header Attributes"
  },
  {
    "id": "agents-grouped-list",
    "label": "Agents Grouped List",
    "sourcePath": "packages/app/agents/components/workspace/agents-grouped-list.tsx",
    "level": "Composites",
    "pathSegments": [
      "Agents",
      "Workspace"
    ],
    "storyId": "agents-grouped-list",
    "storyTitle": "Composites v1.0/Agents/Workspace/Agents Grouped List"
  },
  {
    "id": "agents-list-surface-v2",
    "label": "Agents List Surface V2",
    "sourcePath": "packages/app/agents/components/workspace/agents-list-surface-v2.tsx",
    "level": "Composites",
    "pathSegments": [
      "Agents",
      "Workspace"
    ],
    "storyId": "agents-list-surface-v2",
    "storyTitle": "Composites v1.0/Agents/Workspace/Agents List Surface V2"
  },
  {
    "id": "agents-table",
    "label": "Agents Table",
    "sourcePath": "packages/app/agents/components/workspace/agents-table.tsx",
    "level": "Composites",
    "pathSegments": [
      "Agents",
      "Workspace"
    ],
    "storyId": "agents-table",
    "storyTitle": "Composites v1.0/Agents/Workspace/Agents Table"
  },
  {
    "id": "agents-type-tab-strip",
    "label": "Agents Type Tab Strip",
    "sourcePath": "packages/app/agents/components/workspace/agents-type-tab-strip.tsx",
    "level": "Composites",
    "pathSegments": [
      "Agents",
      "Workspace"
    ],
    "storyId": "agents-type-tab-strip",
    "storyTitle": "Composites v1.0/Agents/Workspace/Agents Type Tab Strip"
  },
  {
    "id": "detail-branches-tab",
    "label": "Detail Branches Tab",
    "sourcePath": "packages/app/agents/components/workspace/detail-branches-tab.tsx",
    "level": "Composites",
    "pathSegments": [
      "Agents",
      "Workspace"
    ],
    "storyId": "detail-branches-tab",
    "storyTitle": "Composites v1.0/Agents/Workspace/Detail Branches Tab"
  },
  {
    "id": "detail-sessions-tab",
    "label": "Detail Sessions Tab",
    "sourcePath": "packages/app/agents/components/workspace/detail-sessions-tab.tsx",
    "level": "Composites",
    "pathSegments": [
      "Agents",
      "Workspace"
    ],
    "storyId": "detail-sessions-tab",
    "storyTitle": "Composites v1.0/Agents/Workspace/Detail Sessions Tab"
  },
  {
    "id": "invocation-evidence-list",
    "label": "Invocation Evidence List",
    "sourcePath": "packages/app/agents/components/workspace/invocation-evidence-list.tsx",
    "level": "Composites",
    "pathSegments": [
      "Agents",
      "Workspace"
    ],
    "storyId": "invocation-evidence-list",
    "storyTitle": "Composites v1.0/Agents/Workspace/Invocation Evidence List"
  },
  {
    "id": "loc-per-dollar-cell",
    "label": "LOC Per Dollar Cell",
    "sourcePath": "packages/app/agents/components/workspace/loc-per-dollar-cell.tsx",
    "level": "Composites",
    "pathSegments": [
      "Agents",
      "Workspace"
    ],
    "storyId": "loc-per-dollar-cell",
    "storyTitle": "Composites v1.0/Agents/Workspace/LOC Per Dollar Cell"
  },
  {
    "id": "promote-modal",
    "label": "Promote Modal",
    "sourcePath": "packages/app/agents/components/workspace/promote-modal.tsx",
    "level": "Composites",
    "pathSegments": [
      "Agents",
      "Workspace"
    ],
    "storyId": "promote-modal",
    "storyTitle": "Composites v1.0/Agents/Workspace/Promote Modal"
  },
  {
    "id": "token-trend-chart",
    "label": "Token Trend Chart",
    "sourcePath": "packages/app/agents/components/workspace/token-trend-chart.tsx",
    "level": "Composites",
    "pathSegments": [
      "Agents",
      "Workspace"
    ],
    "storyId": "token-trend-chart",
    "storyTitle": "Composites v1.0/Agents/Workspace/Token Trend Chart"
  },
  {
    "id": "artifact-priority",
    "label": "Artifact Priority",
    "sourcePath": "packages/app/shared/components/artifact-priority/artifact-priority.tsx",
    "level": "Composites",
    "pathSegments": [
      "App Shell"
    ],
    "storyId": "artifact-priority",
    "storyTitle": "Composites v1.0/App Shell/Artifact Priority"
  },
  {
    "id": "bulk-action-bar",
    "label": "Bulk Action Bar",
    "sourcePath": "packages/app/shared/components/generic-artifact-surface/bulk-action-bar.tsx",
    "level": "Composites",
    "pathSegments": [
      "App Shell"
    ],
    "storyId": "bulk-action-bar",
    "storyTitle": "Composites v1.0/App Shell/Bulk Action Bar"
  },
  {
    "id": "collaborators",
    "label": "Collaborators",
    "sourcePath": "packages/app/shared/components/collaborators.tsx",
    "level": "Composites",
    "pathSegments": [
      "App Shell"
    ],
    "storyId": "collaborators",
    "storyTitle": "Composites v1.0/App Shell/Collaborators"
  },
  {
    "id": "comment-avatar",
    "label": "Comment Avatar",
    "sourcePath": "packages/app/shared/components/comment-avatar.tsx",
    "level": "Composites",
    "pathSegments": [
      "App Shell"
    ],
    "storyId": "comment-avatar",
    "storyTitle": "Composites v1.0/App Shell/Comment Avatar"
  },
  {
    "id": "data-sync-level-picker",
    "label": "Data Sync Level Picker",
    "sourcePath": "packages/app/shared/components/data-sync-level-picker.tsx",
    "level": "Composites",
    "pathSegments": [
      "App Shell"
    ],
    "storyId": "data-sync-level-picker",
    "storyTitle": "Composites v1.0/App Shell/Data Sync Level Picker"
  },
  {
    "id": "dev-tools-overlay",
    "label": "Dev Tools Overlay",
    "sourcePath": "packages/app/shared/dev-tools/components/dev-tools-overlay.tsx",
    "level": "Composites",
    "pathSegments": [
      "App Shell"
    ],
    "storyId": "dev-tools-overlay",
    "storyTitle": "Composites v1.0/App Shell/Dev Tools Overlay"
  },
  {
    "id": "generic-artifact-surface",
    "label": "Generic Artifact Surface",
    "sourcePath": "packages/app/shared/components/generic-artifact-surface/generic-artifact-surface.stories.tsx",
    "level": "Composites",
    "pathSegments": [
      "App Shell"
    ],
    "storyId": "generic-artifact-surface",
    "storyTitle": "Composites v1.0/App Shell/Generic Artifact Surface"
  },
  {
    "id": "list-surface-pagination-footer",
    "label": "List Surface Pagination Footer",
    "sourcePath": "packages/app/shared/components/list-surface-pagination-footer.tsx",
    "level": "Composites",
    "pathSegments": [
      "App Shell"
    ],
    "storyId": "list-surface-pagination-footer",
    "storyTitle": "Composites v1.0/App Shell/List Surface Pagination Footer"
  },
  {
    "id": "prototype-shell",
    "label": "Prototype Shell",
    "sourcePath": "packages/app/shell/v2/components/prototype-shell.tsx",
    "level": "Composites",
    "pathSegments": [
      "App Shell"
    ],
    "storyId": "prototype-shell",
    "storyTitle": "Composites v1.0/App Shell/Prototype Shell"
  },
  {
    "id": "read-source-badge",
    "label": "Read Source Badge",
    "sourcePath": "packages/app/shared/components/read-source-badge.tsx",
    "level": "Composites",
    "pathSegments": [
      "App Shell"
    ],
    "storyId": "read-source-badge",
    "storyTitle": "Composites v1.0/App Shell/Read Source Badge"
  },
  {
    "id": "related-sessions-table-cell",
    "label": "Related Sessions Table Cell",
    "sourcePath": "packages/app/shared/components/generic-artifact-surface/related-sessions-table-cell.tsx",
    "level": "Composites",
    "pathSegments": [
      "App Shell"
    ],
    "storyId": "related-sessions-table-cell",
    "storyTitle": "Composites v1.0/App Shell/Related Sessions Table Cell"
  },
  {
    "id": "shell-sidebar",
    "label": "Shell Sidebar",
    "sourcePath": "packages/app/shell/v2/components/shell-sidebar.tsx",
    "level": "Composites",
    "pathSegments": [
      "App Shell"
    ],
    "storyId": "shell-sidebar",
    "storyTitle": "Composites v1.0/App Shell/Shell Sidebar"
  },
  {
    "id": "status-badge",
    "label": "Status Badge",
    "sourcePath": "packages/app/shared/components/status-badge.tsx",
    "level": "Composites",
    "pathSegments": [
      "App Shell"
    ],
    "storyId": "status-badge",
    "storyTitle": "Composites v1.0/App Shell/Status Badge"
  },
  {
    "id": "summary-card-row",
    "label": "Summary Card Row",
    "sourcePath": "packages/app/shared/components/summary-card-row.tsx",
    "level": "Composites",
    "pathSegments": [
      "App Shell"
    ],
    "storyId": "summary-card-row",
    "storyTitle": "Composites v1.0/App Shell/Summary Card Row"
  },
  {
    "id": "summary-metrics-loading-row",
    "label": "Summary Metrics Loading Row",
    "sourcePath": "packages/app/shared/components/summary-metrics-loading-row.tsx",
    "level": "Composites",
    "pathSegments": [
      "App Shell"
    ],
    "storyId": "summary-metrics-loading-row",
    "storyTitle": "Composites v1.0/App Shell/Summary Metrics Loading Row"
  },
  {
    "id": "timezone-mode-filter",
    "label": "Timezone Mode Filter",
    "sourcePath": "packages/app/shared/components/timezone-mode-filter.tsx",
    "level": "Composites",
    "pathSegments": [
      "App Shell"
    ],
    "storyId": "timezone-mode-filter",
    "storyTitle": "Composites v1.0/App Shell/Timezone Mode Filter"
  },
  {
    "id": "artifact-bar",
    "label": "Artifact Bar",
    "sourcePath": "packages/app/artifacts/components/artifact-bar.tsx",
    "level": "Composites",
    "pathSegments": [
      "Artifacts"
    ],
    "storyId": "artifact-bar",
    "storyTitle": "Composites v1.0/Artifacts/Artifact Bar"
  },
  {
    "id": "timeline-peak-bucket-fact",
    "label": "Timeline Peak Bucket Fact",
    "sourcePath": "packages/app/agents/components/detail/timeline-peak-bucket-fact.tsx",
    "level": "Composites",
    "pathSegments": [
      "Artifacts"
    ],
    "storyId": "timeline-peak-bucket-fact",
    "version": "v2.0",
    "storyTitle": "Composites/Artifacts/Timeline Peak Bucket Fact"
  },
  {
    "id": "branch-sessions-timeline-panel",
    "label": "Branch Sessions Timeline Panel",
    "sourcePath": "packages/app/branches/components/detail/branch-sessions-timeline-panel.stories.tsx",
    "level": "Composites",
    "pathSegments": [
      "Artifacts",
      "Branches",
      "Branch Detail"
    ],
    "storyId": "branch-sessions-timeline-panel",
    "version": "v2.0",
    "storyTitle": "Composites/Artifacts/Branches/Branch Detail/Branch Sessions Timeline Panel"
  },
  {
    "id": "session-upload-state-badge",
    "label": "Session Upload State Badge",
    "sourcePath": "packages/app/agents/components/sessions/session-upload-state-badge.stories.tsx",
    "level": "Composites",
    "pathSegments": [
      "Artifacts",
      "Sessions"
    ],
    "storyId": "session-upload-state-badge",
    "version": "v2.0",
    "storyTitle": "Composites/Artifacts/Sessions/Session Upload State Badge"
  },
  {
    "id": "session-trace-chart",
    "label": "Session Trace Chart",
    "sourcePath": "packages/app/agents/components/detail/trace/session-trace-chart.tsx",
    "level": "Composites",
    "pathSegments": [
      "Artifacts",
      "Sessions",
      "Session Detail"
    ],
    "storyId": "session-trace-chart",
    "version": "v2.0",
    "storyTitle": "Composites/Artifacts/Sessions/Session Detail/Session Trace Chart"
  },
  {
    "id": "session-trace-inspector",
    "label": "Session Trace Inspector",
    "sourcePath": "packages/app/agents/components/detail/trace/session-trace-inspector.tsx",
    "level": "Composites",
    "pathSegments": [
      "Artifacts",
      "Sessions",
      "Session Detail"
    ],
    "storyId": "session-trace-inspector",
    "version": "v2.0",
    "storyTitle": "Composites/Artifacts/Sessions/Session Detail/Session Trace Inspector"
  },
  {
    "id": "session-trace-toolbar",
    "label": "Session Trace Toolbar",
    "sourcePath": "packages/app/agents/components/detail/trace/session-trace-toolbar.tsx",
    "level": "Composites",
    "pathSegments": [
      "Artifacts",
      "Sessions",
      "Session Detail"
    ],
    "storyId": "session-trace-toolbar",
    "version": "v2.0",
    "storyTitle": "Composites/Artifacts/Sessions/Session Detail/Session Trace Toolbar"
  },
  {
    "id": "session-inline-rename",
    "label": "Session Inline Rename",
    "sourcePath": "packages/app/agents/components/sessions/session-inline-rename.stories.tsx",
    "level": "Composites",
    "pathSegments": [
      "Artifacts",
      "Sessions",
      "Sessions List"
    ],
    "storyId": "session-inline-rename",
    "version": "v2.0",
    "storyTitle": "Composites/Artifacts/Sessions/Sessions List/Session Inline Rename"
  },
  {
    "id": "session-tags-cell",
    "label": "Session Tags Cell",
    "sourcePath": "packages/app/agents/components/sessions/session-tags-cell.tsx",
    "level": "Composites",
    "pathSegments": [
      "Artifacts",
      "Sessions",
      "Sessions List"
    ],
    "storyId": "session-tags-cell",
    "version": "v2.0",
    "storyTitle": "Composites/Artifacts/Sessions/Sessions List/Session Tags Cell"
  },
  {
    "id": "branch-cohort-notice",
    "label": "Branch Cohort Notice",
    "sourcePath": "packages/app/branches/components/branch-cohort-notice.tsx",
    "level": "Composites",
    "pathSegments": [
      "Branches"
    ],
    "storyId": "branch-cohort-notice",
    "storyTitle": "Composites v1.0/Branches/Branch Cohort Notice"
  },
  {
    "id": "branch-comment-card",
    "label": "Branch Comment Card",
    "sourcePath": "packages/app/branches/components/comments/branch-comment-card.tsx",
    "level": "Composites",
    "pathSegments": [
      "Branches"
    ],
    "storyId": "branch-comment-card",
    "storyTitle": "Composites v1.0/Branches/Branch Comment Card"
  },
  {
    "id": "branch-comments-pane",
    "label": "Branch Comments Pane",
    "sourcePath": "packages/app/branches/components/comments/branch-comments-pane.tsx",
    "level": "Composites",
    "pathSegments": [
      "Branches"
    ],
    "storyId": "branch-comments-pane",
    "storyTitle": "Composites v1.0/Branches/Branch Comments Pane"
  },
  {
    "id": "branch-comments-rail",
    "label": "Branch Comments Rail",
    "sourcePath": "packages/app/branches/components/comments/branch-comments-rail.tsx",
    "level": "Composites",
    "pathSegments": [
      "Branches"
    ],
    "storyId": "branch-comments-rail",
    "storyTitle": "Composites v1.0/Branches/Branch Comments Rail"
  },
  {
    "id": "branch-cost-to-merge",
    "label": "Branch Cost To Merge",
    "sourcePath": "packages/app/branches/components/branch-cost-to-merge.tsx",
    "level": "Composites",
    "pathSegments": [
      "Branches"
    ],
    "storyId": "branch-cost-to-merge",
    "storyTitle": "Composites v1.0/Branches/Branch Cost To Merge"
  },
  {
    "id": "branch-delivered-panel",
    "label": "Branch Delivered Panel",
    "sourcePath": "packages/app/branches/components/detail/branch-delivered-panel.tsx",
    "level": "Composites",
    "pathSegments": [
      "Branches"
    ],
    "storyId": "branch-delivered-panel",
    "storyTitle": "Composites v1.0/Branches/Branch Delivered Panel"
  },
  {
    "id": "branch-event-dot-rail",
    "label": "Branch Event Dot Rail",
    "sourcePath": "packages/app/branches/components/branch-event-dot-rail.tsx",
    "level": "Composites",
    "pathSegments": [
      "Branches"
    ],
    "storyId": "branch-event-dot-rail",
    "storyTitle": "Composites v1.0/Branches/Branch Event Dot Rail"
  },
  {
    "id": "branch-files-changed-panel",
    "label": "Branch Files Changed Panel",
    "sourcePath": "packages/app/branches/components/detail/branch-files-changed-panel.tsx",
    "level": "Composites",
    "pathSegments": [
      "Branches"
    ],
    "storyId": "branch-files-changed-panel",
    "storyTitle": "Composites v1.0/Branches/Branch Files Changed Panel"
  },
  {
    "id": "branch-headline-cards",
    "label": "Branch Headline Cards",
    "sourcePath": "packages/app/branches/components/branch-headline-cards.tsx",
    "level": "Composites",
    "pathSegments": [
      "Branches"
    ],
    "storyId": "branch-headline-cards",
    "storyTitle": "Composites v1.0/Branches/Branch Headline Cards"
  },
  {
    "id": "branch-lead-time-waterfall",
    "label": "Branch Lead Time Waterfall",
    "sourcePath": "packages/app/branches/components/branch-lead-time-waterfall.tsx",
    "level": "Composites",
    "pathSegments": [
      "Branches"
    ],
    "storyId": "branch-lead-time-waterfall",
    "storyTitle": "Composites v1.0/Branches/Branch Lead Time Waterfall"
  },
  {
    "id": "branch-merged-trace",
    "label": "Branch Merged Trace",
    "sourcePath": "packages/app/branches/components/branch-merged-trace.tsx",
    "level": "Composites",
    "pathSegments": [
      "Branches"
    ],
    "storyId": "branch-merged-trace",
    "storyTitle": "Composites v1.0/Branches/Branch Merged Trace"
  },
  {
    "id": "branch-pr-activity-timeline",
    "label": "Branch PR Activity Timeline",
    "sourcePath": "packages/app/branches/components/branch-pr-activity-timeline.tsx",
    "level": "Composites",
    "pathSegments": [
      "Branches"
    ],
    "storyId": "branch-pr-activity-timeline",
    "storyTitle": "Composites v1.0/Branches/Branch PR Activity Timeline"
  },
  {
    "id": "branch-pr-session-swimlane",
    "label": "Branch PR Session Swimlane",
    "sourcePath": "packages/app/branches/components/branch-pr-session-swimlane.tsx",
    "level": "Composites",
    "pathSegments": [
      "Branches"
    ],
    "storyId": "branch-pr-session-swimlane",
    "storyTitle": "Composites v1.0/Branches/Branch PR Session Swimlane"
  },
  {
    "id": "branch-pr-status-panel",
    "label": "Branch PR Status Panel",
    "sourcePath": "packages/app/branches/components/detail/branch-pr-status-panel.tsx",
    "level": "Composites",
    "pathSegments": [
      "Branches"
    ],
    "storyId": "branch-pr-status-panel",
    "storyTitle": "Composites v1.0/Branches/Branch PR Status Panel"
  },
  {
    "id": "branch-properties-panel",
    "label": "Branch Properties Panel",
    "sourcePath": "packages/app/branches/components/branch-properties-panel.tsx",
    "level": "Composites",
    "pathSegments": [
      "Branches"
    ],
    "storyId": "branch-properties-panel",
    "storyTitle": "Composites v1.0/Branches/Branch Properties Panel"
  },
  {
    "id": "branch-pull-request-selector",
    "label": "Branch Pull Request Selector",
    "sourcePath": "packages/app/branches/components/branch-pull-request-selector.tsx",
    "level": "Composites",
    "pathSegments": [
      "Branches"
    ],
    "storyId": "branch-pull-request-selector",
    "storyTitle": "Composites v1.0/Branches/Branch Pull Request Selector"
  },
  {
    "id": "branch-selected-pull-request-workspace",
    "label": "Branch Selected Pull Request Workspace",
    "sourcePath": "packages/app/branches/components/detail/branch-selected-pull-request-workspace.tsx",
    "level": "Composites",
    "pathSegments": [
      "Branches"
    ],
    "storyId": "branch-selected-pull-request-workspace",
    "storyTitle": "Composites v1.0/Branches/Branch Selected Pull Request Workspace"
  },
  {
    "id": "branch-sessions-timeline-tab",
    "label": "Branch Sessions Timeline Tab",
    "sourcePath": "packages/app/branches/components/detail/branch-sessions-timeline-tab.tsx",
    "level": "Composites",
    "pathSegments": [
      "Branches"
    ],
    "storyId": "branch-sessions-timeline-tab",
    "storyTitle": "Composites v1.0/Branches/Branch Sessions Timeline Tab"
  },
  {
    "id": "branch-trace-actor-avatar",
    "label": "Branch Trace Actor Avatar",
    "sourcePath": "packages/app/branches/components/branch-trace-actor-avatar.tsx",
    "level": "Composites",
    "pathSegments": [
      "Branches"
    ],
    "storyId": "branch-trace-actor-avatar",
    "storyTitle": "Composites v1.0/Branches/Branch Trace Actor Avatar"
  },
  {
    "id": "branches-list-summary-band",
    "label": "Branches List Summary Band",
    "sourcePath": "packages/app/branches/components/branches-list-summary-band.tsx",
    "level": "Composites",
    "pathSegments": [
      "Branches"
    ],
    "storyId": "branches-list-summary-band",
    "storyTitle": "Composites v1.0/Branches/Branches List Summary Band"
  },
  {
    "id": "branches-list-surface-v2",
    "label": "Branches List Surface V2",
    "sourcePath": "packages/app/branches/components/branches-list-surface-v2.tsx",
    "level": "Composites",
    "pathSegments": [
      "Branches"
    ],
    "storyId": "branches-list-surface-v2",
    "storyTitle": "Composites v1.0/Branches/Branches List Surface V2"
  },
  {
    "id": "branches-list-toolbar-v2",
    "label": "Branches List Toolbar V2",
    "sourcePath": "packages/app/branches/components/branches-list-toolbar-v2.tsx",
    "level": "Composites",
    "pathSegments": [
      "Branches"
    ],
    "storyId": "branches-list-toolbar-v2",
    "storyTitle": "Composites v1.0/Branches/Branches List Toolbar V2"
  },
  {
    "id": "branches-summary-cards",
    "label": "Branches Summary Cards",
    "sourcePath": "packages/app/branches/components/branches-summary-cards.tsx",
    "level": "Composites",
    "pathSegments": [
      "Branches"
    ],
    "storyId": "branches-summary-cards",
    "storyTitle": "Composites v1.0/Branches/Branches Summary Cards"
  },
  {
    "id": "branches-table",
    "label": "Branches Table",
    "sourcePath": "packages/app/branches/components/branches-table.tsx",
    "level": "Composites",
    "pathSegments": [
      "Branches"
    ],
    "storyId": "branches-table",
    "storyTitle": "Composites v1.0/Branches/Branches Table"
  },
  {
    "id": "github-connect-return-notice",
    "label": "GitHub Connect Return Notice",
    "sourcePath": "packages/app/branches/components/github-connect-return-notice.tsx",
    "level": "Composites",
    "pathSegments": [
      "Branches"
    ],
    "storyId": "github-connect-return-notice",
    "storyTitle": "Composites v1.0/Branches/GitHub Connect Return Notice"
  },
  {
    "id": "pr-comment-markdown",
    "label": "PR Comment Markdown",
    "sourcePath": "packages/app/branches/components/pr-comment-markdown.tsx",
    "level": "Composites",
    "pathSegments": [
      "Branches"
    ],
    "storyId": "pr-comment-markdown",
    "storyTitle": "Composites v1.0/Branches/PR Comment Markdown"
  },
  {
    "id": "compute-target-card",
    "label": "Compute Target Card",
    "sourcePath": "packages/app/compute/components/compute-target-card.tsx",
    "level": "Composites",
    "pathSegments": [
      "Compute"
    ],
    "storyId": "compute-target-card",
    "storyTitle": "Composites v1.0/Compute/Compute Target Card"
  },
  {
    "id": "compute-target-row",
    "label": "Compute Target Row",
    "sourcePath": "packages/app/compute/components/compute-target-row.tsx",
    "level": "Composites",
    "pathSegments": [
      "Compute"
    ],
    "storyId": "compute-target-row",
    "storyTitle": "Composites v1.0/Compute/Compute Target Row"
  },
  {
    "id": "compute-target-sync-table",
    "label": "Compute Target Sync Table",
    "sourcePath": "packages/app/compute/components/compute-target-sync-table.tsx",
    "level": "Composites",
    "pathSegments": [
      "Compute"
    ],
    "storyId": "compute-target-sync-table",
    "storyTitle": "Composites v1.0/Compute/Compute Target Sync Table"
  },
  {
    "id": "desktop-security",
    "label": "Desktop Security",
    "sourcePath": "packages/app/compute/components/desktop-security.tsx",
    "level": "Composites",
    "pathSegments": [
      "Compute"
    ],
    "storyId": "desktop-security",
    "storyTitle": "Composites v1.0/Compute/Desktop Security"
  },
  {
    "id": "dashboard-scope-control",
    "label": "Dashboard Scope Control",
    "sourcePath": "packages/app/insights/components/overview/dashboard-scope-control.tsx",
    "level": "Composites",
    "pathSegments": [
      "Dashboard"
    ],
    "storyId": "dashboard-scope-control",
    "version": "v2.0",
    "storyTitle": "Composites/Dashboard/Dashboard Scope Control"
  },
  {
    "id": "diagnostics-surface-v2",
    "label": "Diagnostics Surface V2",
    "sourcePath": "packages/app/diagnostics/components/diagnostics-surface-v2.tsx",
    "level": "Composites",
    "pathSegments": [
      "Diagnostics"
    ],
    "storyId": "diagnostics-surface-v2",
    "storyTitle": "Composites v1.0/Diagnostics/Diagnostics Surface V2"
  },
  {
    "id": "withheld-section",
    "label": "Withheld Section",
    "sourcePath": "packages/app/diagnostics/components/withheld-section.tsx",
    "level": "Composites",
    "pathSegments": [
      "Diagnostics"
    ],
    "storyId": "withheld-section",
    "storyTitle": "Composites v1.0/Diagnostics/Withheld Section"
  },
  {
    "id": "activity-actor",
    "label": "Activity Actor",
    "sourcePath": "packages/app/documents/components/feed-sidebar/sources/activity-actor.tsx",
    "level": "Composites",
    "pathSegments": [
      "Documents"
    ],
    "storyId": "activity-actor",
    "storyTitle": "Composites v1.0/Documents/Activity Actor"
  },
  {
    "id": "activity-card-view",
    "label": "Activity Card View",
    "sourcePath": "packages/app/documents/components/feed-sidebar/sources/activity-card-view.tsx",
    "level": "Composites",
    "pathSegments": [
      "Documents"
    ],
    "storyId": "activity-card-view",
    "storyTitle": "Composites v1.0/Documents/Activity Card View"
  },
  {
    "id": "artifact-repositories-summary",
    "label": "Artifact Repositories Summary",
    "sourcePath": "packages/app/documents/components/artifact-repositories-summary.tsx",
    "level": "Composites",
    "pathSegments": [
      "Documents"
    ],
    "storyId": "artifact-repositories-summary",
    "storyTitle": "Composites v1.0/Documents/Artifact Repositories Summary"
  },
  {
    "id": "artifact-row-view",
    "label": "Artifact Row View",
    "sourcePath": "packages/app/documents/components/relationships/artifact-row-view.tsx",
    "level": "Composites",
    "pathSegments": [
      "Documents"
    ],
    "storyId": "artifact-row-view",
    "storyTitle": "Composites v1.0/Documents/Artifact Row View"
  },
  {
    "id": "attachment-list",
    "label": "Attachment List",
    "sourcePath": "packages/app/documents/components/attachment-list.tsx",
    "level": "Composites",
    "pathSegments": [
      "Documents"
    ],
    "storyId": "attachment-list",
    "storyTitle": "Composites v1.0/Documents/Attachment List"
  },
  {
    "id": "branches-section",
    "label": "Branches Section",
    "sourcePath": "packages/app/documents/components/relationships/branches-section.tsx",
    "level": "Composites",
    "pathSegments": [
      "Documents"
    ],
    "storyId": "branches-section",
    "storyTitle": "Composites v1.0/Documents/Branches Section"
  },
  {
    "id": "cell-tooltip",
    "label": "Cell Tooltip",
    "sourcePath": "packages/app/documents/components/table/cells/cell-tooltip.tsx",
    "level": "Composites",
    "pathSegments": [
      "Documents"
    ],
    "storyId": "cell-tooltip",
    "storyTitle": "Composites v1.0/Documents/Cell Tooltip"
  },
  {
    "id": "comments-section",
    "label": "Comments Section",
    "sourcePath": "packages/app/documents/components/comments-section.tsx",
    "level": "Composites",
    "pathSegments": [
      "Documents"
    ],
    "storyId": "comments-section",
    "storyTitle": "Composites v1.0/Documents/Comments Section"
  },
  {
    "id": "document-activity-section",
    "label": "Document Activity Section",
    "sourcePath": "packages/app/documents/components/document-activity-section.tsx",
    "level": "Composites",
    "pathSegments": [
      "Documents"
    ],
    "storyId": "document-activity-section",
    "storyTitle": "Composites v1.0/Documents/Document Activity Section"
  },
  {
    "id": "document-metadata-bar",
    "label": "Document Metadata Bar",
    "sourcePath": "packages/app/documents/components/document-metadata-bar.tsx",
    "level": "Composites",
    "pathSegments": [
      "Documents"
    ],
    "storyId": "document-metadata-bar",
    "storyTitle": "Composites v1.0/Documents/Document Metadata Bar"
  },
  {
    "id": "document-sessions-tab",
    "label": "Document Sessions Tab",
    "sourcePath": "packages/app/documents/components/document-sessions-tab.tsx",
    "level": "Composites",
    "pathSegments": [
      "Documents"
    ],
    "storyId": "document-sessions-tab",
    "storyTitle": "Composites v1.0/Documents/Document Sessions Tab"
  },
  {
    "id": "document-status-icon",
    "label": "Document Status Icon",
    "sourcePath": "packages/app/documents/components/document-status-icon.tsx",
    "level": "Composites",
    "pathSegments": [
      "Documents"
    ],
    "storyId": "document-status-icon",
    "storyTitle": "Composites v1.0/Documents/Document Status Icon"
  },
  {
    "id": "document-type-badge",
    "label": "Document Type Badge",
    "sourcePath": "packages/app/documents/components/document-type-badge.tsx",
    "level": "Composites",
    "pathSegments": [
      "Documents"
    ],
    "storyId": "document-type-badge",
    "storyTitle": "Composites v1.0/Documents/Document Type Badge"
  },
  {
    "id": "documents-index-empty-state",
    "label": "Documents Index Empty State",
    "sourcePath": "packages/app/documents/components/documents-index-empty-state.tsx",
    "level": "Composites",
    "pathSegments": [
      "Documents"
    ],
    "storyId": "documents-index-empty-state",
    "storyTitle": "Composites v1.0/Documents/Documents Index Empty State"
  },
  {
    "id": "documents-summary-cards",
    "label": "Documents Summary Cards",
    "sourcePath": "packages/app/documents/components/documents-summary-cards.tsx",
    "level": "Composites",
    "pathSegments": [
      "Documents"
    ],
    "storyId": "documents-summary-cards",
    "storyTitle": "Composites v1.0/Documents/Documents Summary Cards"
  },
  {
    "id": "edit-cells",
    "label": "Edit Cells",
    "sourcePath": "packages/app/documents/components/table/cells/edit-cells.tsx",
    "level": "Composites",
    "pathSegments": [
      "Documents"
    ],
    "storyId": "edit-cells",
    "storyTitle": "Composites v1.0/Documents/Edit Cells"
  },
  {
    "id": "favorite-button",
    "label": "Favorite Button",
    "sourcePath": "packages/app/documents/components/favorite-button.tsx",
    "level": "Composites",
    "pathSegments": [
      "Documents"
    ],
    "storyId": "favorite-button",
    "storyTitle": "Composites v1.0/Documents/Favorite Button"
  },
  {
    "id": "issue-status-icon",
    "label": "Issue Status Icon",
    "sourcePath": "packages/app/documents/components/issue-status-icon.tsx",
    "level": "Composites",
    "pathSegments": [
      "Documents"
    ],
    "storyId": "issue-status-icon",
    "storyTitle": "Composites v1.0/Documents/Issue Status Icon"
  },
  {
    "id": "name-cell",
    "label": "Name Cell",
    "sourcePath": "packages/app/documents/components/table/cells/name-cell.tsx",
    "level": "Composites",
    "pathSegments": [
      "Documents"
    ],
    "storyId": "name-cell",
    "storyTitle": "Composites v1.0/Documents/Name Cell"
  },
  {
    "id": "new-document-dialog-shell",
    "label": "New Document Dialog Shell",
    "sourcePath": "packages/app/documents/components/new-document-dialog-shell.tsx",
    "level": "Composites",
    "pathSegments": [
      "Documents"
    ],
    "storyId": "new-document-dialog-shell",
    "storyTitle": "Composites v1.0/Documents/New Document Dialog Shell"
  },
  {
    "id": "rank-slot",
    "label": "Rank Slot",
    "sourcePath": "packages/app/documents/components/table/cells/rank-slot.tsx",
    "level": "Composites",
    "pathSegments": [
      "Documents"
    ],
    "storyId": "rank-slot",
    "storyTitle": "Composites v1.0/Documents/Rank Slot"
  },
  {
    "id": "related-sessions-cell",
    "label": "Related Sessions Cell",
    "sourcePath": "packages/app/documents/components/related-sessions-cell.tsx",
    "level": "Composites",
    "pathSegments": [
      "Documents"
    ],
    "storyId": "related-sessions-cell",
    "storyTitle": "Composites v1.0/Documents/Related Sessions Cell"
  },
  {
    "id": "status-metadata-section",
    "label": "Status Metadata Section",
    "sourcePath": "packages/app/documents/components/status-metadata-section.tsx",
    "level": "Composites",
    "pathSegments": [
      "Documents"
    ],
    "storyId": "status-metadata-section",
    "storyTitle": "Composites v1.0/Documents/Status Metadata Section"
  },
  {
    "id": "version-actions-toolbar",
    "label": "Version Actions Toolbar",
    "sourcePath": "packages/app/documents/components/version-actions-toolbar.tsx",
    "level": "Composites",
    "pathSegments": [
      "Documents"
    ],
    "storyId": "version-actions-toolbar",
    "storyTitle": "Composites v1.0/Documents/Version Actions Toolbar"
  },
  {
    "id": "help-surface-v2",
    "label": "Help Surface V2",
    "sourcePath": "packages/app/help/components/help-surface-v2.tsx",
    "level": "Composites",
    "pathSegments": [
      "Help"
    ],
    "storyId": "help-surface-v2",
    "storyTitle": "Composites v1.0/Help/Help Surface V2"
  },
  {
    "id": "inbox-surface-v2",
    "label": "Inbox Surface V2",
    "sourcePath": "packages/app/inbox/components/inbox-surface-v2.tsx",
    "level": "Composites",
    "pathSegments": [
      "Inbox"
    ],
    "storyId": "inbox-surface-v2",
    "storyTitle": "Composites v1.0/Inbox/Inbox Surface V2"
  },
  {
    "id": "cost-metric-card",
    "label": "Cost Metric Card",
    "sourcePath": "packages/app/agents/components/sessions/cost-metric-card.tsx",
    "level": "Composites",
    "pathSegments": [
      "Insights"
    ],
    "storyId": "cost-metric-card",
    "storyTitle": "Composites v1.0/Insights/Cost Metric Card"
  },
  {
    "id": "dashboard-empty-surface",
    "label": "Dashboard Empty Surface",
    "sourcePath": "packages/app/insights/components/overview/dashboard-empty-surface.tsx",
    "level": "Composites",
    "pathSegments": [
      "Insights"
    ],
    "storyId": "dashboard-empty-surface",
    "storyTitle": "Composites v1.0/Insights/Dashboard Empty Surface"
  },
  {
    "id": "dashboard-row-slot",
    "label": "Dashboard Row Slot",
    "sourcePath": "packages/app/insights/components/overview/dashboard-row-slot.tsx",
    "level": "Composites",
    "pathSegments": [
      "Insights"
    ],
    "storyId": "dashboard-row-slot",
    "storyTitle": "Composites v1.0/Insights/Dashboard Row Slot"
  },
  {
    "id": "kpi-delta-placeholder",
    "label": "KPI Delta Placeholder",
    "sourcePath": "packages/app/insights/components/kpi-delta-placeholder.tsx",
    "level": "Composites",
    "pathSegments": [
      "Insights"
    ],
    "storyId": "kpi-delta-placeholder",
    "storyTitle": "Composites v1.0/Insights/KPI Delta Placeholder"
  },
  {
    "id": "kpi-metric-tile",
    "label": "KPI Metric Tile",
    "sourcePath": "packages/app/insights/components/kpi-metric-tile.stories.tsx",
    "level": "Composites",
    "pathSegments": [
      "Insights"
    ],
    "storyId": "kpi-metric-tile",
    "storyTitle": "Composites v1.0/Insights/KPI Metric Tile"
  },
  {
    "id": "metric-picker",
    "label": "Metric Picker",
    "sourcePath": "packages/app/insights/components/metric-picker.tsx",
    "level": "Composites",
    "pathSegments": [
      "Insights"
    ],
    "storyId": "metric-picker",
    "storyTitle": "Composites v1.0/Insights/Metric Picker"
  },
  {
    "id": "model-usage-chart",
    "label": "Model Usage Chart",
    "sourcePath": "packages/app/insights/components/overview/model-usage-chart.tsx",
    "level": "Composites",
    "pathSegments": [
      "Insights"
    ],
    "storyId": "model-usage-chart",
    "storyTitle": "Composites v1.0/Insights/Model Usage Chart"
  },
  {
    "id": "session-mesh-insights-card",
    "label": "Session Mesh Insights Card",
    "sourcePath": "packages/app/insights/components/session-mesh-insights-card.tsx",
    "level": "Composites",
    "pathSegments": [
      "Insights"
    ],
    "storyId": "session-mesh-insights-card",
    "storyTitle": "Composites v1.0/Insights/Session Mesh Insights Card"
  },
  {
    "id": "tile-content",
    "label": "Tile Content",
    "sourcePath": "packages/app/insights/components/tile-content.tsx",
    "level": "Composites",
    "pathSegments": [
      "Insights"
    ],
    "storyId": "tile-content",
    "storyTitle": "Composites v1.0/Insights/Tile Content"
  },
  {
    "id": "agent-invocations-grid",
    "label": "Agent Invocations Grid",
    "sourcePath": "packages/app/agents/components/workspace/agent-invocations-grid.tsx",
    "level": "Composites",
    "pathSegments": [
      "Labs",
      "Agents",
      "Agent Detail"
    ],
    "storyId": "agent-invocations-grid",
    "version": "v2.0",
    "storyTitle": "Composites/Labs/Agents/Agent Detail/Agent Invocations Grid"
  },
  {
    "id": "activity-brief",
    "label": "Activity Brief",
    "sourcePath": "packages/app/documents/components/artifact-activity/activity-brief.tsx",
    "level": "Composites",
    "pathSegments": [
      "Labs",
      "Issues",
      "Issue Detail"
    ],
    "storyId": "activity-brief",
    "version": "v2.0",
    "storyTitle": "Composites/Labs/Issues/Issue Detail/Activity Brief"
  },
  {
    "id": "my-tasks-card-view",
    "label": "My Tasks Card View",
    "sourcePath": "packages/app/my-tasks/components/my-tasks-card-view.tsx",
    "level": "Composites",
    "pathSegments": [
      "My Tasks"
    ],
    "storyId": "my-tasks-card-view",
    "storyTitle": "Composites v1.0/My Tasks/My Tasks Card View"
  },
  {
    "id": "my-tasks-load-failed-state",
    "label": "My Tasks Load Failed State",
    "sourcePath": "packages/app/my-tasks/components/my-tasks-load-failed-state.tsx",
    "level": "Composites",
    "pathSegments": [
      "My Tasks"
    ],
    "storyId": "my-tasks-load-failed-state",
    "storyTitle": "Composites v1.0/My Tasks/My Tasks Load Failed State"
  },
  {
    "id": "my-tasks-pagination-footer",
    "label": "My Tasks Pagination Footer",
    "sourcePath": "packages/app/my-tasks/components/my-tasks-pagination-footer.tsx",
    "level": "Composites",
    "pathSegments": [
      "My Tasks"
    ],
    "storyId": "my-tasks-pagination-footer",
    "storyTitle": "Composites v1.0/My Tasks/My Tasks Pagination Footer"
  },
  {
    "id": "my-tasks-recency-empty-state",
    "label": "My Tasks Recency Empty State",
    "sourcePath": "packages/app/my-tasks/components/my-tasks-recency-empty-state.tsx",
    "level": "Composites",
    "pathSegments": [
      "My Tasks"
    ],
    "storyId": "my-tasks-recency-empty-state",
    "storyTitle": "Composites v1.0/My Tasks/My Tasks Recency Empty State"
  },
  {
    "id": "auth-methods",
    "label": "Auth Methods",
    "sourcePath": "packages/app/onboarding/components/auth-methods.tsx",
    "level": "Composites",
    "pathSegments": [
      "Onboarding"
    ],
    "storyId": "auth-methods",
    "storyTitle": "Composites v1.0/Onboarding/Auth Methods"
  },
  {
    "id": "auth-transition-panel",
    "label": "Auth Transition Panel",
    "sourcePath": "packages/app/onboarding/components/auth-transition-panel.tsx",
    "level": "Composites",
    "pathSegments": [
      "Onboarding"
    ],
    "storyId": "auth-transition-panel",
    "storyTitle": "Composites v1.0/Onboarding/Auth Transition Panel"
  },
  {
    "id": "dashboard-tour",
    "label": "Dashboard Tour",
    "sourcePath": "packages/app/onboarding/components/dashboard-tour/dashboard-tour.tsx",
    "level": "Composites",
    "pathSegments": [
      "Onboarding"
    ],
    "storyId": "dashboard-tour",
    "storyTitle": "Composites v1.0/Onboarding/Dashboard Tour"
  },
  {
    "id": "desktop-availability-notify-form",
    "label": "Desktop Availability Notify Form",
    "sourcePath": "packages/app/onboarding/components/desktop-availability-notify-form.tsx",
    "level": "Composites",
    "pathSegments": [
      "Onboarding"
    ],
    "storyId": "desktop-availability-notify-form",
    "version": "v2.0",
    "storyTitle": "Composites/Onboarding/Desktop Availability Notify Form"
  },
  {
    "id": "desktop-download-action",
    "label": "Desktop Download Action",
    "sourcePath": "packages/app/onboarding/components/desktop-download-action.tsx",
    "level": "Composites",
    "pathSegments": [
      "Onboarding"
    ],
    "storyId": "desktop-download-action",
    "storyTitle": "Composites v1.0/Onboarding/Desktop Download Action"
  },
  {
    "id": "desktop-undetected-notice",
    "label": "Desktop Undetected Notice",
    "sourcePath": "packages/app/onboarding/components/desktop-undetected-notice.tsx",
    "level": "Composites",
    "pathSegments": [
      "Onboarding"
    ],
    "storyId": "desktop-undetected-notice",
    "storyTitle": "Composites v1.0/Onboarding/Desktop Undetected Notice"
  },
  {
    "id": "guided-getting-started-card",
    "label": "Guided Getting Started Card",
    "sourcePath": "packages/app/onboarding/components/guided-getting-started-card.tsx",
    "level": "Composites",
    "pathSegments": [
      "Onboarding"
    ],
    "storyId": "guided-getting-started-card",
    "storyTitle": "Composites v1.0/Onboarding/Guided Getting Started Card"
  },
  {
    "id": "guided-onboarding-dialog",
    "label": "Guided Onboarding Dialog",
    "sourcePath": "packages/app/onboarding/components/guided-onboarding-dialog.tsx",
    "level": "Composites",
    "pathSegments": [
      "Onboarding"
    ],
    "storyId": "guided-onboarding-dialog",
    "storyTitle": "Composites v1.0/Onboarding/Guided Onboarding Dialog"
  },
  {
    "id": "guided-onboarding-directory-step",
    "label": "Guided Onboarding Directory Step",
    "sourcePath": "packages/app/onboarding/components/guided-onboarding-directory-step.tsx",
    "level": "Composites",
    "pathSegments": [
      "Onboarding"
    ],
    "storyId": "guided-onboarding-directory-step",
    "version": "v2.0",
    "storyTitle": "Composites/Onboarding/Guided Onboarding Directory Step"
  },
  {
    "id": "guided-onboarding-organization-logo-field",
    "label": "Guided Onboarding Organization Logo Field",
    "sourcePath": "packages/app/onboarding/components/guided-onboarding-organization-logo-field.tsx",
    "level": "Composites",
    "pathSegments": [
      "Onboarding"
    ],
    "storyId": "guided-onboarding-organization-logo-field",
    "storyTitle": "Composites v1.0/Onboarding/Guided Onboarding Organization Logo Field"
  },
  {
    "id": "guided-onboarding-phases",
    "label": "Guided Onboarding Phases",
    "sourcePath": "packages/app/onboarding/components/guided-onboarding-phases.stories.tsx",
    "level": "Composites",
    "pathSegments": [
      "Onboarding"
    ],
    "storyId": "guided-onboarding-phases",
    "storyTitle": "Composites v1.0/Onboarding/Guided Onboarding Phases"
  },
  {
    "id": "onboarding-analysis-banner",
    "label": "Onboarding Analysis Banner",
    "sourcePath": "packages/app/onboarding/components/onboarding-analysis-banner.tsx",
    "level": "Composites",
    "pathSegments": [
      "Onboarding"
    ],
    "storyId": "onboarding-analysis-banner",
    "storyTitle": "Composites v1.0/Onboarding/Onboarding Analysis Banner"
  },
  {
    "id": "onboarding-status-unavailable",
    "label": "Onboarding Status Unavailable",
    "sourcePath": "packages/app/onboarding/components/onboarding-status-unavailable.tsx",
    "level": "Composites",
    "pathSegments": [
      "Onboarding"
    ],
    "storyId": "onboarding-status-unavailable",
    "storyTitle": "Composites v1.0/Onboarding/Onboarding Status Unavailable"
  },
  {
    "id": "setup-gate-steps",
    "label": "Setup Gate Steps",
    "sourcePath": "packages/app/onboarding/components/setup-gate-steps.tsx",
    "level": "Composites",
    "pathSegments": [
      "Onboarding"
    ],
    "storyId": "setup-gate-steps",
    "version": "v2.0",
    "storyTitle": "Composites/Onboarding/Setup Gate Steps"
  },
  {
    "id": "invite-team-dialog",
    "label": "Invite Team Dialog",
    "sourcePath": "packages/app/organizations/components/invite-team-dialog.tsx",
    "level": "Composites",
    "pathSegments": [
      "Organizations"
    ],
    "storyId": "invite-team-dialog",
    "storyTitle": "Composites v1.0/Organizations/Invite Team Dialog"
  },
  {
    "id": "multi-email-invite-field",
    "label": "Multi Email Invite Field",
    "sourcePath": "packages/app/organizations/components/multi-email-invite-field.tsx",
    "level": "Composites",
    "pathSegments": [
      "Organizations"
    ],
    "storyId": "multi-email-invite-field",
    "storyTitle": "Composites v1.0/Organizations/Multi Email Invite Field"
  },
  {
    "id": "convert-install-sheet",
    "label": "Convert Install Sheet",
    "sourcePath": "packages/app/packs/components/convert-install-sheet.tsx",
    "level": "Composites",
    "pathSegments": [
      "Packs"
    ],
    "storyId": "convert-install-sheet",
    "storyTitle": "Composites v1.0/Packs/Convert Install Sheet"
  },
  {
    "id": "install-matrix",
    "label": "Install Matrix",
    "sourcePath": "packages/app/packs/components/install-matrix.tsx",
    "level": "Composites",
    "pathSegments": [
      "Packs"
    ],
    "storyId": "install-matrix",
    "storyTitle": "Composites v1.0/Packs/Install Matrix"
  },
  {
    "id": "install-source-label",
    "label": "Install Source Label",
    "sourcePath": "packages/app/packs/components/install-source-label.tsx",
    "level": "Composites",
    "pathSegments": [
      "Packs"
    ],
    "storyId": "install-source-label",
    "storyTitle": "Composites v1.0/Packs/Install Source Label"
  },
  {
    "id": "install-state-status",
    "label": "Install State Status",
    "sourcePath": "packages/app/packs/components/install-state-status.tsx",
    "level": "Composites",
    "pathSegments": [
      "Packs"
    ],
    "storyId": "install-state-status",
    "storyTitle": "Composites v1.0/Packs/Install State Status"
  },
  {
    "id": "member-install-control",
    "label": "Member Install Control",
    "sourcePath": "packages/app/packs/components/member-install-control.tsx",
    "level": "Composites",
    "pathSegments": [
      "Packs"
    ],
    "storyId": "member-install-control",
    "storyTitle": "Composites v1.0/Packs/Member Install Control"
  },
  {
    "id": "pack-card",
    "label": "Pack Card",
    "sourcePath": "packages/app/packs/components/pack-card.tsx",
    "level": "Composites",
    "pathSegments": [
      "Packs"
    ],
    "storyId": "pack-card",
    "storyTitle": "Composites v1.0/Packs/Pack Card"
  },
  {
    "id": "pack-filter-bar",
    "label": "Pack Filter Bar",
    "sourcePath": "packages/app/packs/components/pack-filter-bar.tsx",
    "level": "Composites",
    "pathSegments": [
      "Packs"
    ],
    "storyId": "pack-filter-bar",
    "storyTitle": "Composites v1.0/Packs/Pack Filter Bar"
  },
  {
    "id": "pack-install-dialog",
    "label": "Pack Install Dialog",
    "sourcePath": "packages/app/packs/components/pack-install-dialog.tsx",
    "level": "Composites",
    "pathSegments": [
      "Packs"
    ],
    "storyId": "pack-install-dialog",
    "storyTitle": "Composites v1.0/Packs/Pack Install Dialog"
  },
  {
    "id": "packs-load-failed",
    "label": "Packs Load Failed",
    "sourcePath": "packages/app/packs/components/packs-load-failed.tsx",
    "level": "Composites",
    "pathSegments": [
      "Packs"
    ],
    "storyId": "packs-load-failed",
    "storyTitle": "Composites v1.0/Packs/Packs Load Failed"
  },
  {
    "id": "packs-workspace-skeleton",
    "label": "Packs Workspace Skeleton",
    "sourcePath": "packages/app/packs/components/packs-workspace-skeleton.tsx",
    "level": "Composites",
    "pathSegments": [
      "Packs"
    ],
    "storyId": "packs-workspace-skeleton",
    "storyTitle": "Composites v1.0/Packs/Packs Workspace Skeleton"
  },
  {
    "id": "editable-project-description",
    "label": "Editable Project Description",
    "sourcePath": "packages/app/projects/components/editable-project-description.tsx",
    "level": "Composites",
    "pathSegments": [
      "Projects"
    ],
    "storyId": "editable-project-description",
    "storyTitle": "Composites v1.0/Projects/Editable Project Description"
  },
  {
    "id": "editable-project-title",
    "label": "Editable Project Title",
    "sourcePath": "packages/app/projects/components/editable-project-title.tsx",
    "level": "Composites",
    "pathSegments": [
      "Projects"
    ],
    "storyId": "editable-project-title",
    "storyTitle": "Composites v1.0/Projects/Editable Project Title"
  },
  {
    "id": "project-list",
    "label": "Project List",
    "sourcePath": "packages/app/projects/components/project-list.tsx",
    "level": "Composites",
    "pathSegments": [
      "Projects"
    ],
    "storyId": "project-list",
    "storyTitle": "Composites v1.0/Projects/Project List"
  },
  {
    "id": "project-select-popover",
    "label": "Project Select Popover",
    "sourcePath": "packages/app/projects/components/project-select-popover.tsx",
    "level": "Composites",
    "pathSegments": [
      "Projects"
    ],
    "storyId": "project-select-popover",
    "storyTitle": "Composites v1.0/Projects/Project Select Popover"
  },
  {
    "id": "search-surface-v2",
    "label": "Search Surface V2",
    "sourcePath": "packages/app/search/components/search-surface-v2.tsx",
    "level": "Composites",
    "pathSegments": [
      "Search"
    ],
    "storyId": "search-surface-v2",
    "storyTitle": "Composites v1.0/Search/Search Surface V2"
  },
  {
    "id": "search-surface-v2-page-demo",
    "label": "Search Surface V2 Page Demo",
    "sourcePath": "packages/app/search/components/search-surface-v2-page-demo.tsx",
    "level": "Composites",
    "pathSegments": [
      "Search"
    ],
    "storyId": "search-surface-v2-page-demo",
    "storyTitle": "Composites v1.0/Search/Search Surface V2 Page Demo"
  },
  {
    "id": "unified-search-results",
    "label": "Unified Search Results",
    "sourcePath": "packages/app/search/components/unified-search-results.tsx",
    "level": "Composites",
    "pathSegments": [
      "Search"
    ],
    "storyId": "unified-search-results",
    "storyTitle": "Composites v1.0/Search/Unified Search Results"
  },
  {
    "id": "limit-bar",
    "label": "Limit Bar",
    "sourcePath": "packages/app/session-limits/components/limit-bar.tsx",
    "level": "Composites",
    "pathSegments": [
      "Session Limits"
    ],
    "storyId": "limit-bar",
    "storyTitle": "Composites v1.0/Session Limits/Limit Bar"
  },
  {
    "id": "session-limits-provenance",
    "label": "Session Limits Provenance",
    "sourcePath": "packages/app/session-limits/components/session-limits-provenance.tsx",
    "level": "Composites",
    "pathSegments": [
      "Session Limits"
    ],
    "storyId": "session-limits-provenance",
    "storyTitle": "Composites v1.0/Session Limits/Session Limits Provenance"
  },
  {
    "id": "cloud-sync-state-badge",
    "label": "Cloud Sync State Badge",
    "sourcePath": "packages/app/agents/components/sessions/cloud-sync-state-badge.tsx",
    "level": "Composites",
    "pathSegments": [
      "Sessions"
    ],
    "storyId": "cloud-sync-state-badge",
    "storyTitle": "Composites v1.0/Sessions/Cloud Sync State Badge"
  },
  {
    "id": "session-card",
    "label": "Session Card",
    "sourcePath": "packages/app/agents/components/sessions/session-card.tsx",
    "level": "Composites",
    "pathSegments": [
      "Sessions"
    ],
    "storyId": "session-card",
    "storyTitle": "Composites v1.0/Sessions/Session Card"
  },
  {
    "id": "session-cell-chips",
    "label": "Session Cell Chips",
    "sourcePath": "packages/app/agents/components/sessions/session-cell-chips.tsx",
    "level": "Composites",
    "pathSegments": [
      "Sessions"
    ],
    "storyId": "session-cell-chips",
    "storyTitle": "Composites v1.0/Sessions/Session Cell Chips"
  },
  {
    "id": "session-cost-cell",
    "label": "Session Cost Cell",
    "sourcePath": "packages/app/agents/components/sessions/session-cost-cell.tsx",
    "level": "Composites",
    "pathSegments": [
      "Sessions"
    ],
    "storyId": "session-cost-cell",
    "storyTitle": "Composites v1.0/Sessions/Session Cost Cell"
  },
  {
    "id": "session-detail-table",
    "label": "Session Detail Table",
    "sourcePath": "packages/app/agents/components/sessions/session-detail-table.tsx",
    "level": "Composites",
    "pathSegments": [
      "Sessions"
    ],
    "storyId": "session-detail-table",
    "storyTitle": "Composites v1.0/Sessions/Session Detail Table"
  },
  {
    "id": "session-linked-chips-cell",
    "label": "Session Linked Chips Cell",
    "sourcePath": "packages/app/agents/components/sessions/session-linked-chips-cell.tsx",
    "level": "Composites",
    "pathSegments": [
      "Sessions"
    ],
    "storyId": "session-linked-chips-cell",
    "storyTitle": "Composites v1.0/Sessions/Session Linked Chips Cell"
  },
  {
    "id": "session-priority-cell",
    "label": "Session Priority Cell",
    "sourcePath": "packages/app/agents/components/sessions/session-priority-cell.tsx",
    "level": "Composites",
    "pathSegments": [
      "Sessions"
    ],
    "storyId": "session-priority-cell",
    "storyTitle": "Composites v1.0/Sessions/Session Priority Cell"
  },
  {
    "id": "session-sync-status-badge",
    "label": "Session Sync Status Badge",
    "sourcePath": "packages/app/agents/components/sessions/session-sync-status-badge.tsx",
    "level": "Composites",
    "pathSegments": [
      "Sessions"
    ],
    "storyId": "session-sync-status-badge",
    "storyTitle": "Composites v1.0/Sessions/Session Sync Status Badge"
  },
  {
    "id": "sessions-active-filters-bar",
    "label": "Sessions Active Filters Bar",
    "sourcePath": "packages/app/agents/components/sessions/sessions-active-filters-bar.tsx",
    "level": "Composites",
    "pathSegments": [
      "Sessions"
    ],
    "storyId": "sessions-active-filters-bar",
    "storyTitle": "Composites v1.0/Sessions/Sessions Active Filters Bar"
  },
  {
    "id": "sessions-controls",
    "label": "Sessions Controls",
    "sourcePath": "packages/app/agents/components/sessions/sessions-controls.tsx",
    "level": "Composites",
    "pathSegments": [
      "Sessions"
    ],
    "storyId": "sessions-controls",
    "storyTitle": "Composites v1.0/Sessions/Sessions Controls"
  },
  {
    "id": "sessions-custom-range-control",
    "label": "Sessions Custom Range Control",
    "sourcePath": "packages/app/agents/components/sessions/sessions-custom-range-control.tsx",
    "level": "Composites",
    "pathSegments": [
      "Sessions"
    ],
    "storyId": "sessions-custom-range-control",
    "storyTitle": "Composites v1.0/Sessions/Sessions Custom Range Control"
  },
  {
    "id": "sessions-empty-state",
    "label": "Sessions Empty State",
    "sourcePath": "packages/app/agents/components/sessions/sessions-empty-state.tsx",
    "level": "Composites",
    "pathSegments": [
      "Sessions"
    ],
    "storyId": "sessions-empty-state",
    "storyTitle": "Composites v1.0/Sessions/Sessions Empty State"
  },
  {
    "id": "sessions-list-surface-v2-contracts",
    "label": "Sessions List Surface V2 Contracts",
    "sourcePath": "packages/app/agents/components/sessions/sessions-list-surface-v2-contracts.stories.tsx",
    "level": "Composites",
    "pathSegments": [
      "Sessions"
    ],
    "storyId": "sessions-list-surface-v2-contracts",
    "storyTitle": "Composites v1.0/Sessions/Sessions List Surface V2 Contracts"
  },
  {
    "id": "sessions-recovery-action",
    "label": "Sessions Recovery Action",
    "sourcePath": "packages/app/agents/components/sessions/sessions-recovery-action.tsx",
    "level": "Composites",
    "pathSegments": [
      "Sessions"
    ],
    "storyId": "sessions-recovery-action",
    "storyTitle": "Composites v1.0/Sessions/Sessions Recovery Action"
  },
  {
    "id": "sessions-summary-cards",
    "label": "Sessions Summary Cards",
    "sourcePath": "packages/app/agents/components/sessions/sessions-summary-cards.tsx",
    "level": "Composites",
    "pathSegments": [
      "Sessions"
    ],
    "storyId": "sessions-summary-cards",
    "storyTitle": "Composites v1.0/Sessions/Sessions Summary Cards"
  },
  {
    "id": "sessions-summary-cards-loading",
    "label": "Sessions Summary Cards Loading",
    "sourcePath": "packages/app/agents/components/sessions/sessions-summary-cards-loading.tsx",
    "level": "Composites",
    "pathSegments": [
      "Sessions"
    ],
    "storyId": "sessions-summary-cards-loading",
    "storyTitle": "Composites v1.0/Sessions/Sessions Summary Cards Loading"
  },
  {
    "id": "sessions-summary-delta-slots",
    "label": "Sessions Summary Delta Slots",
    "sourcePath": "packages/app/agents/components/sessions/sessions-summary-delta-slots.tsx",
    "level": "Composites",
    "pathSegments": [
      "Sessions"
    ],
    "storyId": "sessions-summary-delta-slots",
    "storyTitle": "Composites v1.0/Sessions/Sessions Summary Delta Slots"
  },
  {
    "id": "synced-sessions-table",
    "label": "Synced Sessions Table",
    "sourcePath": "packages/app/agents/components/sessions/synced-sessions-table.tsx",
    "level": "Composites",
    "pathSegments": [
      "Sessions"
    ],
    "storyId": "synced-sessions-table",
    "storyTitle": "Composites v1.0/Sessions/Synced Sessions Table"
  },
  {
    "id": "developer-settings-panels",
    "label": "Developer Settings Panels",
    "sourcePath": "packages/app/settings/v2/components/developer-settings-panels.stories.tsx",
    "level": "Composites",
    "pathSegments": [
      "Settings"
    ],
    "storyId": "developer-settings-panels",
    "storyTitle": "Composites v1.0/Settings/Developer Settings Panels"
  },
  {
    "id": "device-settings-panels",
    "label": "Device Settings Panels",
    "sourcePath": "packages/app/settings/v2/components/device-settings-panels.stories.tsx",
    "level": "Composites",
    "pathSegments": [
      "Settings"
    ],
    "storyId": "device-settings-panels",
    "storyTitle": "Composites v1.0/Settings/Device Settings Panels"
  },
  {
    "id": "governance-settings-panels",
    "label": "Governance Settings Panels",
    "sourcePath": "packages/app/settings/v2/components/governance-settings-panels.stories.tsx",
    "level": "Composites",
    "pathSegments": [
      "Settings"
    ],
    "storyId": "governance-settings-panels",
    "storyTitle": "Composites v1.0/Settings/Governance Settings Panels"
  },
  {
    "id": "org-policy-toggle-card",
    "label": "Org Policy Toggle Card",
    "sourcePath": "packages/app/settings/components/org-policy-toggle-card.tsx",
    "level": "Composites",
    "pathSegments": [
      "Settings"
    ],
    "storyId": "org-policy-toggle-card",
    "storyTitle": "Composites v1.0/Settings/Org Policy Toggle Card"
  },
  {
    "id": "organization-general-panel",
    "label": "Organization General Panel",
    "sourcePath": "packages/app/settings/v2/components/organization-general-panel.stories.tsx",
    "level": "Composites",
    "pathSegments": [
      "Settings"
    ],
    "storyId": "organization-general-panel",
    "storyTitle": "Composites v1.0/Settings/Organization General Panel"
  },
  {
    "id": "session-frustration-card",
    "label": "Session Frustration Card",
    "sourcePath": "packages/app/settings/components/session-frustration-card.tsx",
    "level": "Composites",
    "pathSegments": [
      "Settings"
    ],
    "storyId": "session-frustration-card",
    "storyTitle": "Composites v1.0/Settings/Session Frustration Card"
  },
  {
    "id": "settings-panel-data-state-view",
    "label": "Settings Panel Data State View",
    "sourcePath": "packages/app/settings/v2/components/settings-panel-data-state-view.tsx",
    "level": "Composites",
    "pathSegments": [
      "Settings"
    ],
    "storyId": "settings-panel-data-state-view",
    "storyTitle": "Composites v1.0/Settings/Settings Panel Data State View"
  },
  {
    "id": "settings-panel-status-view",
    "label": "Settings Panel Status View",
    "sourcePath": "packages/app/settings/v2/components/settings-panel-status-view.tsx",
    "level": "Composites",
    "pathSegments": [
      "Settings"
    ],
    "storyId": "settings-panel-status-view",
    "storyTitle": "Composites v1.0/Settings/Settings Panel Status View"
  },
  {
    "id": "workspace-menu",
    "label": "Workspace Menu",
    "sourcePath": "packages/app/settings/v2/components/workspace-menu/workspace-menu.tsx",
    "level": "Composites",
    "pathSegments": [
      "Settings"
    ],
    "storyId": "workspace-menu",
    "storyTitle": "Composites v1.0/Settings/Workspace Menu"
  },
  {
    "id": "activity-card",
    "label": "Activity Card",
    "sourcePath": "packages/app/documents/components/artifact-activity/activity-card.stories.tsx",
    "level": "Composites",
    "pathSegments": [
      "Shared",
      "Activity"
    ],
    "storyId": "activity-card",
    "version": "v2.0",
    "storyTitle": "Composites/Shared/Activity/Activity Card"
  },
  {
    "id": "activity-comment-card",
    "label": "Activity Comment Card",
    "sourcePath": "packages/app/documents/components/artifact-activity/activity-comment-card.stories.tsx",
    "level": "Composites",
    "pathSegments": [
      "Shared",
      "Activity"
    ],
    "storyId": "activity-comment-card",
    "version": "v2.0",
    "storyTitle": "Composites/Shared/Activity/Activity Comment Card"
  },
  {
    "id": "activity-timeline",
    "label": "Activity Timeline",
    "sourcePath": "packages/app/documents/components/artifact-activity/activity-timeline.tsx",
    "level": "Composites",
    "pathSegments": [
      "Shared",
      "Activity"
    ],
    "storyId": "activity-timeline",
    "version": "v2.0",
    "storyTitle": "Composites/Shared/Activity/Activity Timeline"
  },
  {
    "id": "mention-suggestion-list",
    "label": "Mention Suggestion List",
    "sourcePath": "packages/app/shared/components/mention-suggestion-list.tsx",
    "level": "Composites",
    "pathSegments": [
      "Shared",
      "Activity"
    ],
    "storyId": "mention-suggestion-list",
    "version": "v2.0",
    "storyTitle": "Composites/Shared/Activity/Mention Suggestion List"
  },
  {
    "id": "artifact-tab",
    "label": "Artifact Tab",
    "sourcePath": "packages/app/shared/components/artifact-detail-shell/artifact-tab.tsx",
    "level": "Composites",
    "pathSegments": [
      "Shared",
      "Artifact Detail"
    ],
    "storyId": "artifact-tab",
    "version": "v2.0",
    "storyTitle": "Composites/Shared/Artifact Detail/Artifact Tab"
  },
  {
    "id": "comments-pane",
    "label": "Comments Pane",
    "sourcePath": "packages/app/shared/components/comments/comments-pane.tsx",
    "level": "Composites",
    "pathSegments": [
      "Shared",
      "Artifact Detail"
    ],
    "storyId": "comments-pane",
    "version": "v2.0",
    "storyTitle": "Composites/Shared/Artifact Detail/Comments Pane"
  },
  {
    "id": "linked-artifact-groups-table",
    "label": "Linked Artifact Groups Table",
    "sourcePath": "packages/app/shared/components/generic-artifact-surface/preview/components/linked-artifact-groups-table.stories.tsx",
    "level": "Composites",
    "pathSegments": [
      "Shared",
      "Artifact Detail"
    ],
    "storyId": "linked-artifact-groups-table",
    "version": "v2.0",
    "storyTitle": "Composites/Shared/Artifact Detail/Linked Artifact Groups Table"
  },
  {
    "id": "artifact-board",
    "label": "Artifact Board",
    "sourcePath": "packages/app/shared/components/generic-artifact-surface/artifact-board/artifact-board.tsx",
    "level": "Composites",
    "pathSegments": [
      "Shared",
      "Artifact List"
    ],
    "storyId": "artifact-board",
    "version": "v2.0",
    "storyTitle": "Composites/Shared/Artifact List/Artifact Board"
  },
  {
    "id": "bulk-tag-picker",
    "label": "Bulk Tag Picker",
    "sourcePath": "packages/app/tags/components/bulk-tag-picker.tsx",
    "level": "Composites",
    "pathSegments": [
      "Shared",
      "Artifact List"
    ],
    "storyId": "bulk-tag-picker",
    "version": "v2.0",
    "storyTitle": "Composites/Shared/Artifact List/Bulk Tag Picker"
  },
  {
    "id": "documents-view",
    "label": "Documents View",
    "sourcePath": "packages/app/documents/components/table/documents-view.tsx",
    "level": "Composites",
    "pathSegments": [
      "Shared",
      "Artifact List"
    ],
    "storyId": "documents-view",
    "version": "v2.0",
    "storyTitle": "Composites/Shared/Artifact List/Documents View"
  },
  {
    "id": "data-controls-scope-editor",
    "label": "Data Controls Scope Editor",
    "sourcePath": "packages/app/shared/components/data-controls-scope-editor.tsx",
    "level": "Composites",
    "pathSegments": [
      "Shared",
      "Data Controls"
    ],
    "storyId": "data-controls-scope-editor",
    "version": "v2.0",
    "storyTitle": "Composites/Shared/Data Controls/Data Controls Scope Editor"
  },
  {
    "id": "deletion-entry-point",
    "label": "Deletion Entry Point",
    "sourcePath": "packages/app/shared/components/deletion-entry-point.tsx",
    "level": "Composites",
    "pathSegments": [
      "Shared",
      "Data Controls"
    ],
    "storyId": "deletion-entry-point",
    "version": "v2.0",
    "storyTitle": "Composites/Shared/Data Controls/Deletion Entry Point"
  },
  {
    "id": "deletion-request-tracker",
    "label": "Deletion Request Tracker",
    "sourcePath": "packages/app/shared/components/deletion-request-tracker.tsx",
    "level": "Composites",
    "pathSegments": [
      "Shared",
      "Data Controls"
    ],
    "storyId": "deletion-request-tracker",
    "version": "v2.0",
    "storyTitle": "Composites/Shared/Data Controls/Deletion Request Tracker"
  },
  {
    "id": "deletion-scope-review",
    "label": "Deletion Scope Review",
    "sourcePath": "packages/app/shared/components/deletion-scope-review.tsx",
    "level": "Composites",
    "pathSegments": [
      "Shared",
      "Data Controls"
    ],
    "storyId": "deletion-scope-review",
    "version": "v2.0",
    "storyTitle": "Composites/Shared/Data Controls/Deletion Scope Review"
  },
  {
    "id": "policy-status-indicator",
    "label": "Policy Status Indicator",
    "sourcePath": "packages/app/shared/components/policy-status-indicator.tsx",
    "level": "Composites",
    "pathSegments": [
      "Shared",
      "Data Controls"
    ],
    "storyId": "policy-status-indicator",
    "version": "v2.0",
    "storyTitle": "Composites/Shared/Data Controls/Policy Status Indicator"
  },
  {
    "id": "upload-queue-view",
    "label": "Upload Queue View",
    "sourcePath": "packages/app/shared/components/upload-queue-view.tsx",
    "level": "Composites",
    "pathSegments": [
      "Shared",
      "Data Controls"
    ],
    "storyId": "upload-queue-view",
    "version": "v2.0",
    "storyTitle": "Composites/Shared/Data Controls/Upload Queue View"
  },
  {
    "id": "uploads-pause-control",
    "label": "Uploads Pause Control",
    "sourcePath": "packages/app/shared/components/uploads-pause-control.tsx",
    "level": "Composites",
    "pathSegments": [
      "Shared",
      "Data Controls"
    ],
    "storyId": "uploads-pause-control",
    "version": "v2.0",
    "storyTitle": "Composites/Shared/Data Controls/Uploads Pause Control"
  },
  {
    "id": "data-sync-level-card",
    "label": "Data Sync Level Card",
    "sourcePath": "packages/app/shared/components/data-sync-level-card.tsx",
    "level": "Composites",
    "pathSegments": [
      "Shared",
      "Data Sync"
    ],
    "storyId": "data-sync-level-card",
    "version": "v2.0",
    "storyTitle": "Composites/Shared/Data Sync/Data Sync Level Card"
  },
  {
    "id": "data-sync-policy-choice",
    "label": "Data Sync Policy Choice",
    "sourcePath": "packages/app/shared/components/data-sync-policy-choice.tsx",
    "level": "Composites",
    "pathSegments": [
      "Shared",
      "Data Sync"
    ],
    "storyId": "data-sync-policy-choice",
    "version": "v2.0",
    "storyTitle": "Composites/Shared/Data Sync/Data Sync Policy Choice"
  },
  {
    "id": "data-sync-policy-summary",
    "label": "Data Sync Policy Summary",
    "sourcePath": "packages/app/shared/components/data-sync-policy-summary.tsx",
    "level": "Composites",
    "pathSegments": [
      "Shared",
      "Data Sync"
    ],
    "storyId": "data-sync-policy-summary",
    "version": "v2.0",
    "storyTitle": "Composites/Shared/Data Sync/Data Sync Policy Summary"
  },
  {
    "id": "device-data-policy",
    "label": "Device Data Policy",
    "sourcePath": "packages/app/shared/components/device-data-policy.tsx",
    "level": "Composites",
    "pathSegments": [
      "Shared",
      "Data Sync"
    ],
    "storyId": "device-data-policy",
    "version": "v2.0",
    "storyTitle": "Composites/Shared/Data Sync/Device Data Policy"
  },
  {
    "id": "directory-scope-list",
    "label": "Directory Scope List",
    "sourcePath": "packages/app/shared/components/directory-scope-list.tsx",
    "level": "Composites",
    "pathSegments": [
      "Shared",
      "Data Sync"
    ],
    "storyId": "directory-scope-list",
    "version": "v2.0",
    "storyTitle": "Composites/Shared/Data Sync/Directory Scope List"
  },
  {
    "id": "directory-scope-list-with-add",
    "label": "Directory Scope List With Add",
    "sourcePath": "packages/app/shared/components/directory-scope-list-with-add.tsx",
    "level": "Composites",
    "pathSegments": [
      "Shared",
      "Data Sync"
    ],
    "storyId": "directory-scope-list-with-add",
    "version": "v2.0",
    "storyTitle": "Composites/Shared/Data Sync/Directory Scope List With Add"
  },
  {
    "id": "session-share-exception-list",
    "label": "Session Share Exception List",
    "sourcePath": "packages/app/agents/components/sessions/session-share-exception-list.tsx",
    "level": "Composites",
    "pathSegments": [
      "Shared",
      "Data Sync"
    ],
    "storyId": "session-share-exception-list",
    "version": "v2.0",
    "storyTitle": "Composites/Shared/Data Sync/Session Share Exception List"
  },
  {
    "id": "prototype-scenario-panel",
    "label": "Prototype Scenario Panel",
    "sourcePath": "packages/app/shell/v2/components/prototype-scenario-panel.tsx",
    "level": "Composites",
    "pathSegments": [
      "Shared",
      "Prototype Tools"
    ],
    "storyId": "prototype-scenario-panel",
    "version": "v2.0",
    "storyTitle": "Composites/Shared/Prototype Tools/Prototype Scenario Panel"
  },
  {
    "id": "entity-tags-cell",
    "label": "Entity Tags Cell",
    "sourcePath": "packages/app/tags/components/entity-tags-cell.tsx",
    "level": "Composites",
    "pathSegments": [
      "Tags"
    ],
    "storyId": "entity-tags-cell",
    "storyTitle": "Composites v1.0/Tags/Entity Tags Cell"
  },
  {
    "id": "tag-chip",
    "label": "Tag Chip",
    "sourcePath": "packages/app/shared/components/tag-chip.tsx",
    "level": "Composites",
    "pathSegments": [
      "Tags"
    ],
    "storyId": "tag-chip",
    "storyTitle": "Composites v1.0/Tags/Tag Chip"
  },
  {
    "id": "tag-picker",
    "label": "Tag Picker",
    "sourcePath": "packages/app/tags/components/tag-picker.tsx",
    "level": "Composites",
    "pathSegments": [
      "Tags"
    ],
    "storyId": "tag-picker",
    "storyTitle": "Composites v1.0/Tags/Tag Picker"
  },
  {
    "id": "sidebar-teams",
    "label": "Sidebar Teams",
    "sourcePath": "packages/app/teams/components/sidebar-teams.tsx",
    "level": "Composites",
    "pathSegments": [
      "Your Teams"
    ],
    "storyId": "sidebar-teams",
    "version": "v2.0",
    "storyTitle": "Composites/Your Teams/Sidebar Teams"
  },
  {
    "id": "team-modal",
    "label": "Team Modal",
    "sourcePath": "packages/app/teams/components/team-modal.tsx",
    "level": "Composites",
    "pathSegments": [
      "Your Teams"
    ],
    "storyId": "team-modal",
    "version": "v2.0",
    "storyTitle": "Composites/Your Teams/Team Modal"
  },
  {
    "id": "project-artifact-board",
    "label": "Project Artifact Board",
    "sourcePath": "packages/app/projects/components/project-artifact-board.tsx",
    "level": "Composites",
    "pathSegments": [
      "Your Teams",
      "Project Detail"
    ],
    "storyId": "project-artifact-board",
    "version": "v2.0",
    "storyTitle": "Composites/Your Teams/Project Detail/Project Artifact Board"
  },
  {
    "id": "project-artifact-list",
    "label": "Project Artifact List",
    "sourcePath": "packages/app/projects/components/project-artifact-list.tsx",
    "level": "Composites",
    "pathSegments": [
      "Your Teams",
      "Project Detail"
    ],
    "storyId": "project-artifact-list",
    "version": "v2.0",
    "storyTitle": "Composites/Your Teams/Project Detail/Project Artifact List"
  },
  {
    "id": "project-artifact-summary",
    "label": "Project Artifact Summary",
    "sourcePath": "packages/app/projects/components/project-artifact-summary.tsx",
    "level": "Composites",
    "pathSegments": [
      "Your Teams",
      "Project Detail"
    ],
    "storyId": "project-artifact-summary",
    "version": "v2.0",
    "storyTitle": "Composites/Your Teams/Project Detail/Project Artifact Summary"
  },
  {
    "id": "branch-artifact-shell",
    "label": "Branch Artifact Shell",
    "sourcePath": "packages/app/branches/components/branch-artifact-shell.stories.tsx",
    "level": "Patterns",
    "pathSegments": [
      "Artifacts",
      "Branches",
      "Branch Detail"
    ],
    "storyId": "branch-artifact-shell",
    "version": "v2.0",
    "storyTitle": "Patterns/Artifacts/Branches/Branch Detail"
  },
  {
    "id": "session-artifact-shell",
    "label": "Session Artifact Shell",
    "sourcePath": "packages/app/agents/components/detail/session-artifact-shell.stories.tsx",
    "level": "Patterns",
    "pathSegments": [
      "Artifacts",
      "Sessions",
      "Session Detail"
    ],
    "storyId": "session-artifact-shell",
    "version": "v2.0",
    "storyTitle": "Patterns/Artifacts/Sessions/Session Detail"
  },
  {
    "id": "artifact-detail-shell",
    "label": "Artifact Detail Shell",
    "sourcePath": "packages/app/shared/components/artifact-detail-shell/artifact-detail-shell.tsx",
    "level": "Patterns",
    "pathSegments": [
      "Shared",
      "Artifact Detail"
    ],
    "storyId": "artifact-detail-shell",
    "version": "v2.0",
    "storyTitle": "Patterns/Shared/Artifact Detail"
  },
  {
    "id": "agent-pipeline-graph",
    "label": "Agent Pipeline Graph",
    "sourcePath": "packages/app/agents/components/agent-pipeline-graph.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Charts"
    ],
    "storyId": "agent-pipeline-graph",
    "storyTitle": "Primitives v1.0/Charts/Agent Pipeline Graph"
  },
  {
    "id": "session-output-diff",
    "label": "Session Output Diff",
    "sourcePath": "packages/app/agents/components/detail/session-output-diff.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Content"
    ],
    "storyId": "session-output-diff",
    "storyTitle": "Primitives v1.0/Content/Session Output Diff"
  },
  {
    "id": "artifact-priority-editor",
    "label": "Artifact Priority Editor",
    "sourcePath": "packages/app/documents/components/artifact-priority/artifact-priority-editor.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "artifact-priority-editor",
    "storyTitle": "Primitives v1.0/Data Display/Artifact Priority Editor"
  },
  {
    "id": "branch-priority-cell",
    "label": "Branch Priority Cell",
    "sourcePath": "packages/app/branches/components/branch-priority-cell.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "branch-priority-cell",
    "storyTitle": "Primitives v1.0/Data Display/Branch Priority Cell"
  },
  {
    "id": "branch-project-value",
    "label": "Branch Project Value",
    "sourcePath": "packages/app/branches/components/branch-project-value.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "branch-project-value",
    "storyTitle": "Primitives v1.0/Data Display/Branch Project Value"
  },
  {
    "id": "connect-github-indicator",
    "label": "Connect GitHub Indicator",
    "sourcePath": "packages/app/branches/components/connect-github-indicator.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "connect-github-indicator",
    "storyTitle": "Primitives v1.0/Data Display/Connect GitHub Indicator"
  },
  {
    "id": "overview-metric",
    "label": "Overview Metric",
    "sourcePath": "packages/app/insights/components/overview/overview-metric.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "overview-metric",
    "storyTitle": "Primitives v1.0/Data Display/Overview Metric"
  },
  {
    "id": "session-branches-row",
    "label": "Session Branches Row",
    "sourcePath": "packages/app/agents/components/detail/session-branches-row.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "session-branches-row",
    "storyTitle": "Primitives v1.0/Data Display/Session Branches Row"
  },
  {
    "id": "session-comments-rail",
    "label": "Session Comments Rail",
    "sourcePath": "packages/app/agents/components/detail/session-comments-rail.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "session-comments-rail",
    "storyTitle": "Primitives v1.0/Data Display/Session Comments Rail"
  },
  {
    "id": "session-group-icons",
    "label": "Session Group Icons",
    "sourcePath": "packages/app/agents/components/sessions/session-group-icons.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "session-group-icons",
    "storyTitle": "Primitives v1.0/Data Display/Session Group Icons"
  },
  {
    "id": "session-limits-detail",
    "label": "Session Limits Detail",
    "sourcePath": "packages/app/session-limits/components/session-limits-detail.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "session-limits-detail",
    "storyTitle": "Primitives v1.0/Data Display/Session Limits Detail"
  },
  {
    "id": "session-loc-per-dollar-property",
    "label": "Session LOC Per Dollar Property",
    "sourcePath": "packages/app/agents/components/detail/session-loc-per-dollar-property.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "session-loc-per-dollar-property",
    "storyTitle": "Primitives v1.0/Data Display/Session LOC Per Dollar Property"
  },
  {
    "id": "session-other-repositories-row",
    "label": "Session Other Repositories Row",
    "sourcePath": "packages/app/agents/components/detail/session-other-repositories-row.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "session-other-repositories-row",
    "storyTitle": "Primitives v1.0/Data Display/Session Other Repositories Row"
  },
  {
    "id": "session-pull-requests-row",
    "label": "Session Pull Requests Row",
    "sourcePath": "packages/app/agents/components/detail/session-pull-requests-row.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "session-pull-requests-row",
    "storyTitle": "Primitives v1.0/Data Display/Session Pull Requests Row"
  },
  {
    "id": "branch-cell-primitives",
    "label": "Branch Cell Primitives",
    "sourcePath": "packages/app/branches/components/branch-cell-primitives.stories.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Data Display",
      "Tables"
    ],
    "storyId": "branch-cell-primitives",
    "storyTitle": "Primitives v1.0/Data Display/Tables/Branch Cell Primitives"
  },
  {
    "id": "static-cells",
    "label": "Static Cells",
    "sourcePath": "packages/app/documents/components/table/cells/static-cells.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Data Display",
      "Tables"
    ],
    "storyId": "static-cells",
    "storyTitle": "Primitives v1.0/Data Display/Tables/Static Cells"
  },
  {
    "id": "tags-cell",
    "label": "Tags Cell",
    "sourcePath": "packages/app/documents/components/table/cells/tags-cell.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Data Display",
      "Tables"
    ],
    "storyId": "tags-cell",
    "storyTitle": "Primitives v1.0/Data Display/Tables/Tags Cell"
  },
  {
    "id": "artifact-status",
    "label": "Artifact Status",
    "sourcePath": "packages/app/shared/components/artifact-status/artifact-status.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Feedback & Status"
    ],
    "storyId": "artifact-status",
    "storyTitle": "Primitives v1.0/Feedback & Status/Artifact Status"
  },
  {
    "id": "branch-provider-availability",
    "label": "Branch Provider Availability",
    "sourcePath": "packages/app/branches/components/comments/branch-provider-availability.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Feedback & Status"
    ],
    "storyId": "branch-provider-availability",
    "storyTitle": "Primitives v1.0/Feedback & Status/Branch Provider Availability"
  },
  {
    "id": "feature-flag-pending",
    "label": "Feature Flag Pending",
    "sourcePath": "packages/app/shared/components/feature-flag-pending.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Feedback & Status"
    ],
    "storyId": "feature-flag-pending",
    "storyTitle": "Primitives v1.0/Feedback & Status/Feature Flag Pending"
  },
  {
    "id": "session-provenance-chip",
    "label": "Session Provenance Chip",
    "sourcePath": "packages/app/agents/components/sessions/session-provenance-chip.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Feedback & Status"
    ],
    "storyId": "session-provenance-chip",
    "storyTitle": "Primitives v1.0/Feedback & Status/Session Provenance Chip"
  },
  {
    "id": "session-status-icon",
    "label": "Session Status Icon",
    "sourcePath": "packages/app/documents/components/table/session-status-icon.stories.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Feedback & Status"
    ],
    "storyId": "session-status-icon",
    "storyTitle": "Primitives v1.0/Feedback & Status/Session Status Icon"
  },
  {
    "id": "tag-color-picker",
    "label": "Tag Color Picker",
    "sourcePath": "packages/app/shared/components/tag-color-picker.tsx",
    "level": "Primitives",
    "pathSegments": [
      "Inputs"
    ],
    "storyId": "tag-color-picker",
    "storyTitle": "Primitives v1.0/Inputs/Tag Color Picker"
  },
  {
    "id": "agent-detail",
    "label": "Agent Detail",
    "sourcePath": "packages/app/agents/components/workspace/agent-detail.tsx",
    "level": "Surfaces",
    "pathSegments": [
      "Agents"
    ],
    "storyId": "agent-detail",
    "storyTitle": "Surfaces v1.0/Agents/Agent Detail"
  },
  {
    "id": "branch-detail-page",
    "label": "Branch Detail Page",
    "sourcePath": "packages/app/branches/components/branch-detail-page.tsx",
    "level": "Surfaces",
    "pathSegments": [
      "Branches"
    ],
    "storyId": "branch-detail-page",
    "storyTitle": "Surfaces v1.0/Branches/Branch Detail Page"
  },
  {
    "id": "branch-shell-view",
    "label": "Branch Shell View",
    "sourcePath": "packages/app/branches/components/branch-shell-view.tsx",
    "level": "Surfaces",
    "pathSegments": [
      "Branches"
    ],
    "storyId": "branch-shell-view",
    "storyTitle": "Surfaces v1.0/Branches/Branch Shell View"
  },
  {
    "id": "branch-comments-workspace",
    "label": "Comments Workspace",
    "sourcePath": "packages/app/branches/components/comments/branch-comments-workspace.tsx",
    "level": "Surfaces",
    "pathSegments": [
      "Branches"
    ],
    "storyId": "branch-comments-workspace",
    "storyTitle": "Surfaces v1.0/Branches/Comments Workspace"
  },
  {
    "id": "issues-index-view",
    "label": "Listing",
    "sourcePath": "packages/app/issues/components/issues-index-view.tsx",
    "level": "Surfaces",
    "pathSegments": [
      "Issues"
    ],
    "storyId": "issues-index-view",
    "storyTitle": "Surfaces v1.0/Issues/Listing"
  },
  {
    "id": "pack-detail",
    "label": "Pack Detail",
    "sourcePath": "packages/app/packs/components/pack-detail.tsx",
    "level": "Surfaces",
    "pathSegments": [
      "Packs"
    ],
    "storyId": "pack-detail",
    "storyTitle": "Surfaces v1.0/Packs/Pack Detail"
  },
  {
    "id": "packs-workspace",
    "label": "Packs Workspace",
    "sourcePath": "packages/app/packs/components/packs-workspace.tsx",
    "level": "Surfaces",
    "pathSegments": [
      "Packs"
    ],
    "storyId": "packs-workspace",
    "storyTitle": "Surfaces v1.0/Packs/Packs Workspace"
  },
  {
    "id": "agent-session-shell-view",
    "label": "Agent Session Shell View",
    "sourcePath": "packages/app/agents/components/detail/agent-session-shell-view.tsx",
    "level": "Surfaces",
    "pathSegments": [
      "Sessions"
    ],
    "storyId": "agent-session-shell-view",
    "storyTitle": "Surfaces v1.0/Sessions/Agent Session Shell View"
  },
  {
    "id": "sessions-list-surface-v2",
    "label": "Listing",
    "sourcePath": "packages/app/agents/components/sessions/sessions-list-surface-v2.tsx",
    "level": "Surfaces",
    "pathSegments": [
      "Sessions"
    ],
    "storyId": "sessions-list-surface-v2",
    "storyTitle": "Surfaces v1.0/Sessions/Listing"
  },
  {
    "id": "agent-session-detail-view",
    "label": "Session Detail",
    "sourcePath": "packages/app/agents/components/detail/agent-session-detail-view.tsx",
    "level": "Surfaces",
    "pathSegments": [
      "Sessions"
    ],
    "storyId": "agent-session-detail-view",
    "storyTitle": "Surfaces v1.0/Sessions/Session Detail"
  },
  {
    "id": "session-transcript-panel",
    "label": "Session Transcript Panel",
    "sourcePath": "packages/app/agents/components/detail/session-transcript-panel.tsx",
    "level": "Surfaces",
    "pathSegments": [
      "Sessions"
    ],
    "storyId": "session-transcript-panel",
    "storyTitle": "Surfaces v1.0/Sessions/Session Transcript Panel"
  }
] as const satisfies readonly StorybookCatalogEntry[];

export const desktopComponentCatalog =
  [
  {
    "id": "agent-monitor-db-ahead-banner",
    "label": "Agent Monitor DB Ahead Banner",
    "sourcePath": "apps/desktop/src/renderer/components/agent-monitor-db-ahead-banner.tsx",
    "level": "Composites",
    "pathSegments": [
      "Desktop Shell"
    ],
    "storyId": "agent-monitor-db-ahead-banner",
    "storyTitle": "Composites v1.0/Desktop Shell/Agent Monitor DB Ahead Banner"
  },
  {
    "id": "connection-status-section",
    "label": "Connection Status Section",
    "sourcePath": "apps/desktop/src/renderer/components/settings/connection-status-section.tsx",
    "level": "Composites",
    "pathSegments": [
      "Desktop Shell"
    ],
    "storyId": "connection-status-section",
    "storyTitle": "Composites v1.0/Desktop Shell/Connection Status Section"
  },
  {
    "id": "data-sync-tab",
    "label": "Data Sync Tab",
    "sourcePath": "apps/desktop/src/renderer/components/settings/data-sync-tab.tsx",
    "level": "Composites",
    "pathSegments": [
      "Desktop Shell"
    ],
    "storyId": "data-sync-tab",
    "storyTitle": "Composites v1.0/Desktop Shell/Data Sync Tab"
  },
  {
    "id": "desktop-session-expired-banner",
    "label": "Desktop Session Expired Banner",
    "sourcePath": "apps/desktop/src/renderer/components/desktop-session-expired-banner.tsx",
    "level": "Composites",
    "pathSegments": [
      "Desktop Shell"
    ],
    "storyId": "desktop-session-expired-banner",
    "storyTitle": "Composites v1.0/Desktop Shell/Desktop Session Expired Banner"
  },
  {
    "id": "desktop-shell-sidebar",
    "label": "Desktop Shell Sidebar",
    "sourcePath": "apps/desktop/src/renderer/components/layout/shell-navigation/desktop-shell-sidebar.tsx",
    "level": "Composites",
    "pathSegments": [
      "Desktop Shell"
    ],
    "storyId": "desktop-shell-sidebar",
    "storyTitle": "Composites v1.0/Desktop Shell/Desktop Shell Sidebar"
  },
  {
    "id": "desktop-sync-prompt",
    "label": "Desktop Sync Prompt",
    "sourcePath": "apps/desktop/src/renderer/components/desktop-sync-prompt.tsx",
    "level": "Composites",
    "pathSegments": [
      "Desktop Shell"
    ],
    "storyId": "desktop-sync-prompt",
    "storyTitle": "Composites v1.0/Desktop Shell/Desktop Sync Prompt"
  },
  {
    "id": "global-sandbox-card",
    "label": "Global Sandbox Card",
    "sourcePath": "apps/desktop/src/renderer/components/settings/global-sandbox-card.tsx",
    "level": "Composites",
    "pathSegments": [
      "Desktop Shell"
    ],
    "storyId": "global-sandbox-card",
    "storyTitle": "Composites v1.0/Desktop Shell/Global Sandbox Card"
  },
  {
    "id": "labs-gate-surfaces",
    "label": "Labs Gate Surfaces",
    "sourcePath": "apps/desktop/src/renderer/components/labs-gate-surfaces.tsx",
    "level": "Composites",
    "pathSegments": [
      "Desktop Shell"
    ],
    "storyId": "labs-gate-surfaces",
    "storyTitle": "Composites v1.0/Desktop Shell/Labs Gate Surfaces"
  },
  {
    "id": "opt-in-distributions-banner",
    "label": "Opt In Distributions Banner",
    "sourcePath": "apps/desktop/src/renderer/components/opt-in-distributions-banner.tsx",
    "level": "Composites",
    "pathSegments": [
      "Desktop Shell"
    ],
    "storyId": "opt-in-distributions-banner",
    "storyTitle": "Composites v1.0/Desktop Shell/Opt In Distributions Banner"
  },
  {
    "id": "route-fallbacks",
    "label": "Route Fallbacks",
    "sourcePath": "apps/desktop/src/renderer/components/route-fallbacks.tsx",
    "level": "Composites",
    "pathSegments": [
      "Desktop Shell"
    ],
    "storyId": "route-fallbacks",
    "storyTitle": "Composites v1.0/Desktop Shell/Route Fallbacks"
  },
  {
    "id": "session-limits-nav",
    "label": "Session Limits Nav",
    "sourcePath": "apps/desktop/src/renderer/components/session-limits-nav.stories.tsx",
    "level": "Composites",
    "pathSegments": [
      "Desktop Shell"
    ],
    "storyId": "session-limits-nav",
    "storyTitle": "Composites v1.0/Desktop Shell/Session Limits Nav"
  },
  {
    "id": "sidebar-account-footer",
    "label": "Sidebar Account Footer",
    "sourcePath": "apps/desktop/src/renderer/components/layout/sidebar-account-footer.stories.tsx",
    "level": "Composites",
    "pathSegments": [
      "Desktop Shell"
    ],
    "storyId": "sidebar-account-footer",
    "storyTitle": "Composites v1.0/Desktop Shell/Sidebar Account Footer"
  },
  {
    "id": "sidebar-shared-items",
    "label": "Sidebar Shared Items",
    "sourcePath": "apps/desktop/src/renderer/components/layout/sidebar-shared-items.tsx",
    "level": "Composites",
    "pathSegments": [
      "Desktop Shell"
    ],
    "storyId": "sidebar-shared-items",
    "storyTitle": "Composites v1.0/Desktop Shell/Sidebar Shared Items"
  },
  {
    "id": "update-banner",
    "label": "Update Banner",
    "sourcePath": "apps/desktop/src/renderer/components/update-banner.stories.tsx",
    "level": "Composites",
    "pathSegments": [
      "Desktop Shell"
    ],
    "storyId": "update-banner",
    "storyTitle": "Composites v1.0/Desktop Shell/Update Banner"
  },
  {
    "id": "session-detail-view",
    "label": "Session Detail (Desktop Shell)",
    "sourcePath": "apps/desktop/src/renderer/components/sessions/session-detail-view.stories.tsx",
    "level": "Surfaces",
    "pathSegments": [
      "Sessions"
    ],
    "storyId": "session-detail-view",
    "storyTitle": "Surfaces v1.0/Sessions/Session Detail (Desktop Shell)"
  }
] as const satisfies readonly StorybookCatalogEntry[];

export const storybookComponentCatalog = [
  ...designSystemComponentCatalog,
  ...appComponentCatalog,
  ...appCoreComponentCatalog,
  ...desktopComponentCatalog,
] as const satisfies readonly StorybookCatalogEntry[];

export function hasStory(entry: StorybookCatalogEntry) {
  return Boolean(entry.storyId) && !entry.internal;
}
