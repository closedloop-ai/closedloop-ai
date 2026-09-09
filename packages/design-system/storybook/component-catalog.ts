export const canonicalStorybookRoots = ["Catalog","Design System","App Core"] as const;

export type StorybookCatalogSection = Exclude<
  (typeof canonicalStorybookRoots)[number],
  "Catalog"
>;

export type StorybookCatalogEntry = {
  id: string;
  label: string;
  sourcePath: string;
  section: StorybookCatalogSection;
  pathSegments: readonly string[];
  storyTitle: string;
  storyId?: string;
  storyStatus?: "catalog-only";
  internal?: boolean;
  note?: string;
};

export const designSystemComponentCatalog =
  [
  {
    "id": "brand-icons",
    "label": "Brand Icons",
    "sourcePath": "packages/design-system/components/ui/brand-icons.tsx",
    "section": "Design System",
    "pathSegments": [
      "Primitives"
    ],
    "storyId": "brand-icons",
    "storyTitle": "Design System/Primitives/Brand Icons"
  },
  {
    "id": "button",
    "label": "Button",
    "sourcePath": "packages/design-system/components/ui/button.tsx",
    "section": "Design System",
    "pathSegments": [
      "Primitives"
    ],
    "storyId": "button",
    "storyTitle": "Design System/Primitives/Button"
  },
  {
    "id": "calendar",
    "label": "Calendar",
    "sourcePath": "packages/design-system/components/ui/calendar.tsx",
    "section": "Design System",
    "pathSegments": [
      "Primitives"
    ],
    "storyId": "calendar",
    "storyTitle": "Design System/Primitives/Calendar"
  },
  {
    "id": "checkbox",
    "label": "Checkbox",
    "sourcePath": "packages/design-system/components/ui/checkbox.tsx",
    "section": "Design System",
    "pathSegments": [
      "Primitives"
    ],
    "storyId": "checkbox",
    "storyTitle": "Design System/Primitives/Checkbox"
  },
  {
    "id": "chip",
    "label": "Chip",
    "sourcePath": "packages/design-system/components/ui/chip.tsx",
    "section": "Design System",
    "pathSegments": [
      "Primitives"
    ],
    "storyId": "chip",
    "storyTitle": "Design System/Primitives/Chip"
  },
  {
    "id": "copy-button",
    "label": "Copy Button",
    "sourcePath": "packages/design-system/components/ui/primitives/copy-button.tsx",
    "section": "Design System",
    "pathSegments": [
      "Primitives"
    ],
    "storyId": "copy-button",
    "storyTitle": "Design System/Primitives/Copy Button"
  },
  {
    "id": "donut-slice-textures",
    "label": "Donut Slice Textures",
    "sourcePath": "packages/design-system/components/ui/donut-slice-textures.tsx",
    "section": "Design System",
    "pathSegments": [
      "Primitives"
    ],
    "storyStatus": "catalog-only",
    "storyTitle": "Design System/Primitives/Donut Slice Textures"
  },
  {
    "id": "favorite-button",
    "label": "Favorite Button",
    "sourcePath": "packages/design-system/components/ui/favorite-button.tsx",
    "section": "Design System",
    "pathSegments": [
      "Primitives"
    ],
    "storyId": "favorite-button",
    "storyTitle": "Design System/Primitives/Favorite Button"
  },
  {
    "id": "filter-range-submenu",
    "label": "Filter Range Submenu",
    "sourcePath": "packages/design-system/components/ui/filter-range-submenu.tsx",
    "section": "Design System",
    "pathSegments": [
      "Primitives"
    ],
    "storyStatus": "catalog-only",
    "internal": true,
    "note": "Submenu inside the table filter menu.",
    "storyTitle": "Design System/Primitives/Filter Range Submenu"
  },
  {
    "id": "form",
    "label": "Form",
    "sourcePath": "packages/design-system/components/ui/form.tsx",
    "section": "Design System",
    "pathSegments": [
      "Primitives"
    ],
    "storyId": "form",
    "storyTitle": "Design System/Primitives/Form"
  },
  {
    "id": "grid-table-card",
    "label": "Grid Table Card",
    "sourcePath": "packages/design-system/components/ui/grid-table-card.tsx",
    "section": "Design System",
    "pathSegments": [
      "Primitives"
    ],
    "storyStatus": "catalog-only",
    "internal": true,
    "note": "Card row rendered by GridTable in compact mode.",
    "storyTitle": "Design System/Primitives/Grid Table Card"
  },
  {
    "id": "input",
    "label": "Input",
    "sourcePath": "packages/design-system/components/ui/input.tsx",
    "section": "Design System",
    "pathSegments": [
      "Primitives"
    ],
    "storyId": "input",
    "storyTitle": "Design System/Primitives/Input"
  },
  {
    "id": "label",
    "label": "Label",
    "sourcePath": "packages/design-system/components/ui/label.tsx",
    "section": "Design System",
    "pathSegments": [
      "Primitives"
    ],
    "storyId": "label",
    "storyTitle": "Design System/Primitives/Label"
  },
  {
    "id": "progress",
    "label": "Progress",
    "sourcePath": "packages/design-system/components/ui/progress.tsx",
    "section": "Design System",
    "pathSegments": [
      "Primitives"
    ],
    "storyId": "progress",
    "storyTitle": "Design System/Primitives/Progress"
  },
  {
    "id": "radio-group",
    "label": "Radio Group",
    "sourcePath": "packages/design-system/components/ui/radio-group.tsx",
    "section": "Design System",
    "pathSegments": [
      "Primitives"
    ],
    "storyId": "radio-group",
    "storyTitle": "Design System/Primitives/Radio Group"
  },
  {
    "id": "select",
    "label": "Select",
    "sourcePath": "packages/design-system/components/ui/select.tsx",
    "section": "Design System",
    "pathSegments": [
      "Primitives"
    ],
    "storyId": "select",
    "storyTitle": "Design System/Primitives/Select"
  },
  {
    "id": "skeleton",
    "label": "Skeleton",
    "sourcePath": "packages/design-system/components/ui/skeleton.tsx",
    "section": "Design System",
    "pathSegments": [
      "Primitives"
    ],
    "storyId": "skeleton",
    "storyTitle": "Design System/Primitives/Skeleton"
  },
  {
    "id": "star-rating",
    "label": "Star Rating",
    "sourcePath": "packages/design-system/components/ui/star-rating.tsx",
    "section": "Design System",
    "pathSegments": [
      "Primitives"
    ],
    "storyId": "star-rating",
    "storyTitle": "Design System/Primitives/Star Rating"
  },
  {
    "id": "switch",
    "label": "Switch",
    "sourcePath": "packages/design-system/components/ui/switch.tsx",
    "section": "Design System",
    "pathSegments": [
      "Primitives"
    ],
    "storyId": "switch",
    "storyTitle": "Design System/Primitives/Switch"
  },
  {
    "id": "textarea",
    "label": "Textarea",
    "sourcePath": "packages/design-system/components/ui/textarea.tsx",
    "section": "Design System",
    "pathSegments": [
      "Primitives"
    ],
    "storyId": "textarea",
    "storyTitle": "Design System/Primitives/Textarea"
  },
  {
    "id": "toggle",
    "label": "Toggle",
    "sourcePath": "packages/design-system/components/ui/toggle.tsx",
    "section": "Design System",
    "pathSegments": [
      "Primitives"
    ],
    "storyId": "toggle",
    "storyTitle": "Design System/Primitives/Toggle"
  },
  {
    "id": "toggle-group",
    "label": "Toggle Group",
    "sourcePath": "packages/design-system/components/ui/toggle-group.tsx",
    "section": "Design System",
    "pathSegments": [
      "Primitives"
    ],
    "storyId": "toggle-group",
    "storyTitle": "Design System/Primitives/Toggle Group"
  },
  {
    "id": "workflow-stat-tile",
    "label": "Workflow Stat Tile",
    "sourcePath": "packages/design-system/components/ui/primitives/workflow-stat-tile.tsx",
    "section": "Design System",
    "pathSegments": [
      "Primitives"
    ],
    "storyStatus": "catalog-only",
    "storyTitle": "Design System/Primitives/Workflow Stat Tile"
  },
  {
    "id": "alert-dialog",
    "label": "Alert Dialog",
    "sourcePath": "packages/design-system/components/ui/alert-dialog.tsx",
    "section": "Design System",
    "pathSegments": [
      "Overlays"
    ],
    "storyId": "alert-dialog",
    "storyTitle": "Design System/Overlays/Alert Dialog"
  },
  {
    "id": "command",
    "label": "Command",
    "sourcePath": "packages/design-system/components/ui/command.tsx",
    "section": "Design System",
    "pathSegments": [
      "Overlays"
    ],
    "storyId": "command",
    "storyTitle": "Design System/Overlays/Command"
  },
  {
    "id": "date-picker-popover",
    "label": "Date Picker Popover",
    "sourcePath": "packages/design-system/components/ui/date-picker-popover.tsx",
    "section": "Design System",
    "pathSegments": [
      "Overlays"
    ],
    "storyId": "date-picker-popover",
    "storyTitle": "Design System/Overlays/Date Picker Popover"
  },
  {
    "id": "dialog",
    "label": "Dialog",
    "sourcePath": "packages/design-system/components/ui/dialog.tsx",
    "section": "Design System",
    "pathSegments": [
      "Overlays"
    ],
    "storyId": "dialog",
    "storyTitle": "Design System/Overlays/Dialog"
  },
  {
    "id": "drawer",
    "label": "Drawer",
    "sourcePath": "packages/design-system/components/ui/drawer.tsx",
    "section": "Design System",
    "pathSegments": [
      "Overlays"
    ],
    "storyId": "drawer",
    "storyTitle": "Design System/Overlays/Drawer"
  },
  {
    "id": "dropdown-menu",
    "label": "Dropdown Menu",
    "sourcePath": "packages/design-system/components/ui/dropdown-menu.tsx",
    "section": "Design System",
    "pathSegments": [
      "Overlays"
    ],
    "storyId": "dropdown-menu",
    "storyTitle": "Design System/Overlays/Dropdown Menu"
  },
  {
    "id": "filter-popover",
    "label": "Filter Popover",
    "sourcePath": "packages/design-system/components/ui/filter-popover.tsx",
    "section": "Design System",
    "pathSegments": [
      "Overlays"
    ],
    "storyId": "filter-popover",
    "storyTitle": "Design System/Overlays/Filter Popover"
  },
  {
    "id": "popover",
    "label": "Popover",
    "sourcePath": "packages/design-system/components/ui/popover.tsx",
    "section": "Design System",
    "pathSegments": [
      "Overlays"
    ],
    "storyId": "popover",
    "storyTitle": "Design System/Overlays/Popover"
  },
  {
    "id": "sheet",
    "label": "Sheet",
    "sourcePath": "packages/design-system/components/ui/sheet.tsx",
    "section": "Design System",
    "pathSegments": [
      "Overlays"
    ],
    "storyId": "sheet",
    "storyTitle": "Design System/Overlays/Sheet"
  },
  {
    "id": "sonner",
    "label": "Sonner",
    "sourcePath": "packages/design-system/components/ui/sonner.tsx",
    "section": "Design System",
    "pathSegments": [
      "Overlays"
    ],
    "storyId": "sonner",
    "storyTitle": "Design System/Overlays/Sonner"
  },
  {
    "id": "tooltip",
    "label": "Tooltip",
    "sourcePath": "packages/design-system/components/ui/tooltip.tsx",
    "section": "Design System",
    "pathSegments": [
      "Overlays"
    ],
    "storyId": "tooltip",
    "storyTitle": "Design System/Overlays/Tooltip"
  },
  {
    "id": "user-select-popover",
    "label": "User Select Popover",
    "sourcePath": "packages/design-system/components/ui/user-select-popover.tsx",
    "section": "Design System",
    "pathSegments": [
      "Overlays"
    ],
    "storyId": "user-select-popover",
    "storyTitle": "Design System/Overlays/User Select Popover"
  },
  {
    "id": "alert",
    "label": "Alert",
    "sourcePath": "packages/design-system/components/ui/alert.tsx",
    "section": "Design System",
    "pathSegments": [
      "Feedback & Status"
    ],
    "storyId": "alert",
    "storyTitle": "Design System/Feedback & Status/Alert"
  },
  {
    "id": "empty-state",
    "label": "Empty State",
    "sourcePath": "packages/design-system/components/ui/empty-state.tsx",
    "section": "Design System",
    "pathSegments": [
      "Feedback & Status"
    ],
    "storyId": "empty-state",
    "storyTitle": "Design System/Feedback & Status/Empty State"
  },
  {
    "id": "info-hint",
    "label": "Info Hint",
    "sourcePath": "packages/design-system/components/ui/primitives/info-hint.tsx",
    "section": "Design System",
    "pathSegments": [
      "Feedback & Status"
    ],
    "storyId": "info-hint",
    "storyTitle": "Design System/Feedback & Status/Info Hint"
  },
  {
    "id": "status-badge",
    "label": "Status Badge",
    "sourcePath": "packages/design-system/components/ui/primitives/status-badge.tsx",
    "section": "Design System",
    "pathSegments": [
      "Feedback & Status"
    ],
    "storyId": "status-badge",
    "storyTitle": "Design System/Feedback & Status/Status Badge"
  },
  {
    "id": "status-icon-primitives",
    "label": "Status Icon Primitives",
    "sourcePath": "packages/design-system/components/ui/status-icon-primitives.tsx",
    "section": "Design System",
    "pathSegments": [
      "Feedback & Status"
    ],
    "storyId": "status-icon-primitives",
    "storyTitle": "Design System/Feedback & Status/Status Icon Primitives"
  },
  {
    "id": "card",
    "label": "Card",
    "sourcePath": "packages/design-system/components/ui/card.tsx",
    "section": "Design System",
    "pathSegments": [
      "Layout"
    ],
    "storyId": "card",
    "storyTitle": "Design System/Layout/Card"
  },
  {
    "id": "collapsible",
    "label": "Collapsible",
    "sourcePath": "packages/design-system/components/ui/collapsible.tsx",
    "section": "Design System",
    "pathSegments": [
      "Layout"
    ],
    "storyId": "collapsible",
    "storyTitle": "Design System/Layout/Collapsible"
  },
  {
    "id": "collapsible-section",
    "label": "Collapsible Section",
    "sourcePath": "packages/design-system/components/ui/collapsible-section.tsx",
    "section": "Design System",
    "pathSegments": [
      "Layout"
    ],
    "storyId": "collapsible-section",
    "storyTitle": "Design System/Layout/Collapsible Section"
  },
  {
    "id": "group-section-header",
    "label": "Group Section Header",
    "sourcePath": "packages/design-system/components/ui/group-section-header.tsx",
    "section": "Design System",
    "pathSegments": [
      "Layout"
    ],
    "storyId": "group-section-header",
    "storyTitle": "Design System/Layout/Group Section Header"
  },
  {
    "id": "kanban-board",
    "label": "Kanban Board",
    "sourcePath": "packages/design-system/components/ui/layout/kanban-board.tsx",
    "section": "Design System",
    "pathSegments": [
      "Layout"
    ],
    "storyId": "kanban-board",
    "storyTitle": "Design System/Layout/Kanban Board"
  },
  {
    "id": "resizable",
    "label": "Resizable Panel Group",
    "sourcePath": "packages/design-system/components/ui/resizable.tsx",
    "section": "Design System",
    "pathSegments": [
      "Layout"
    ],
    "storyId": "resizable",
    "storyTitle": "Design System/Layout/Resizable Panel Group"
  },
  {
    "id": "scroll-area",
    "label": "Scroll Area",
    "sourcePath": "packages/design-system/components/ui/scroll-area.tsx",
    "section": "Design System",
    "pathSegments": [
      "Layout"
    ],
    "storyId": "scroll-area",
    "storyTitle": "Design System/Layout/Scroll Area"
  },
  {
    "id": "section",
    "label": "Section",
    "sourcePath": "packages/design-system/components/ui/layout/section.tsx",
    "section": "Design System",
    "pathSegments": [
      "Layout"
    ],
    "storyId": "section",
    "storyTitle": "Design System/Layout/Section"
  },
  {
    "id": "section-header",
    "label": "Section Header",
    "sourcePath": "packages/design-system/components/ui/section-header.tsx",
    "section": "Design System",
    "pathSegments": [
      "Layout"
    ],
    "storyId": "section-header",
    "storyTitle": "Design System/Layout/Section Header"
  },
  {
    "id": "separator",
    "label": "Separator",
    "sourcePath": "packages/design-system/components/ui/separator.tsx",
    "section": "Design System",
    "pathSegments": [
      "Layout"
    ],
    "storyId": "separator",
    "storyTitle": "Design System/Layout/Separator"
  },
  {
    "id": "breadcrumb",
    "label": "Breadcrumb",
    "sourcePath": "packages/design-system/components/ui/breadcrumb.tsx",
    "section": "Design System",
    "pathSegments": [
      "Navigation & Shell"
    ],
    "storyId": "breadcrumb",
    "storyTitle": "Design System/Navigation & Shell/Breadcrumb"
  },
  {
    "id": "mode-toggle",
    "label": "Mode Toggle",
    "sourcePath": "packages/design-system/components/ui/mode-toggle.tsx",
    "section": "Design System",
    "pathSegments": [
      "Navigation & Shell"
    ],
    "storyId": "mode-toggle",
    "storyTitle": "Design System/Navigation & Shell/Mode Toggle"
  },
  {
    "id": "sidebar",
    "label": "Sidebar",
    "sourcePath": "packages/design-system/components/ui/sidebar.tsx",
    "section": "Design System",
    "pathSegments": [
      "Navigation & Shell"
    ],
    "storyId": "sidebar",
    "storyTitle": "Design System/Navigation & Shell/Sidebar"
  },
  {
    "id": "sidebar-collapsible-section",
    "label": "Sidebar Collapsible Section",
    "sourcePath": "packages/design-system/components/ui/sidebar-collapsible-section.tsx",
    "section": "Design System",
    "pathSegments": [
      "Navigation & Shell"
    ],
    "storyId": "sidebar-collapsible-section",
    "storyTitle": "Design System/Navigation & Shell/Sidebar Collapsible Section"
  },
  {
    "id": "sidebar-count-badge",
    "label": "Sidebar Count Badge",
    "sourcePath": "packages/design-system/components/ui/sidebar-count-badge.tsx",
    "section": "Design System",
    "pathSegments": [
      "Navigation & Shell"
    ],
    "storyId": "sidebar-count-badge",
    "storyTitle": "Design System/Navigation & Shell/Sidebar Count Badge"
  },
  {
    "id": "tabs",
    "label": "Tabs",
    "sourcePath": "packages/design-system/components/ui/tabs.tsx",
    "section": "Design System",
    "pathSegments": [
      "Navigation & Shell"
    ],
    "storyId": "tabs",
    "storyTitle": "Design System/Navigation & Shell/Tabs"
  },
  {
    "id": "theme-submenu",
    "label": "Theme Submenu",
    "sourcePath": "packages/design-system/components/ui/theme-submenu.tsx",
    "section": "Design System",
    "pathSegments": [
      "Navigation & Shell"
    ],
    "storyId": "theme-submenu",
    "storyTitle": "Design System/Navigation & Shell/Theme Submenu"
  },
  {
    "id": "underline-tabs",
    "label": "Underline Tabs",
    "sourcePath": "packages/design-system/components/ui/primitives/underline-tabs.tsx",
    "section": "Design System",
    "pathSegments": [
      "Navigation & Shell"
    ],
    "storyId": "underline-tabs",
    "storyTitle": "Design System/Navigation & Shell/Underline Tabs"
  },
  {
    "id": "active-filters-bar",
    "label": "Active Filters Bar",
    "sourcePath": "packages/design-system/components/ui/active-filters-bar.tsx",
    "section": "Design System",
    "pathSegments": [
      "Data Display",
      "Tables"
    ],
    "storyId": "active-filters-bar",
    "storyTitle": "Design System/Data Display/Tables/Active Filters Bar"
  },
  {
    "id": "activity-heatmap",
    "label": "Activity Heatmap",
    "sourcePath": "packages/design-system/components/ui/primitives/activity-heatmap.tsx",
    "section": "Design System",
    "pathSegments": [
      "Data Display",
      "Data Visualization"
    ],
    "storyId": "activity-heatmap",
    "storyTitle": "Design System/Data Display/Data Visualization/Activity Heatmap"
  },
  {
    "id": "analytics-range-toggle",
    "label": "Analytics Range Toggle",
    "sourcePath": "packages/design-system/components/ui/analytics-range-toggle.tsx",
    "section": "Design System",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "analytics-range-toggle",
    "storyTitle": "Design System/Data Display/Analytics Range Toggle"
  },
  {
    "id": "avatar",
    "label": "Avatar",
    "sourcePath": "packages/design-system/components/ui/avatar.tsx",
    "section": "Design System",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "avatar",
    "storyTitle": "Design System/Data Display/Avatar"
  },
  {
    "id": "badge",
    "label": "Badge",
    "sourcePath": "packages/design-system/components/ui/badge.tsx",
    "section": "Design System",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "badge",
    "storyTitle": "Design System/Data Display/Badge"
  },
  {
    "id": "category-bar-chart",
    "label": "Category Bar Chart",
    "sourcePath": "packages/design-system/components/ui/category-bar-chart.tsx",
    "section": "Design System",
    "pathSegments": [
      "Data Display",
      "Data Visualization"
    ],
    "storyId": "category-bar-chart",
    "storyTitle": "Design System/Data Display/Data Visualization/Category Bar Chart"
  },
  {
    "id": "chart",
    "label": "Chart",
    "sourcePath": "packages/design-system/components/ui/chart.tsx",
    "section": "Design System",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "chart",
    "storyTitle": "Design System/Data Display/Chart"
  },
  {
    "id": "data-table",
    "label": "Data Table",
    "sourcePath": "packages/design-system/components/ui/data-table.tsx",
    "section": "Design System",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "data-table",
    "storyTitle": "Design System/Data Display/Data Table"
  },
  {
    "id": "donut-chart",
    "label": "Donut Chart",
    "sourcePath": "packages/design-system/components/ui/donut-chart.tsx",
    "section": "Design System",
    "pathSegments": [
      "Data Display",
      "Data Visualization"
    ],
    "storyId": "donut-chart",
    "storyTitle": "Design System/Data Display/Data Visualization/Donut Chart"
  },
  {
    "id": "file-list",
    "label": "File List",
    "sourcePath": "packages/design-system/components/ui/primitives/file-list.tsx",
    "section": "Design System",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "file-list",
    "storyTitle": "Design System/Data Display/File List"
  },
  {
    "id": "filter-chip",
    "label": "Filter Chip",
    "sourcePath": "packages/design-system/components/ui/filter-chip.tsx",
    "section": "Design System",
    "pathSegments": [
      "Data Display",
      "Tables"
    ],
    "storyId": "filter-chip",
    "storyTitle": "Design System/Data Display/Tables/Filter Chip"
  },
  {
    "id": "graph",
    "label": "Graph",
    "sourcePath": "packages/design-system/components/ui/primitives/graph.tsx",
    "section": "Design System",
    "pathSegments": [
      "Data Display",
      "Data Visualization"
    ],
    "storyId": "graph",
    "storyTitle": "Design System/Data Display/Data Visualization/Graph"
  },
  {
    "id": "grid-table",
    "label": "Grid Table",
    "sourcePath": "packages/design-system/components/ui/grid-table.tsx",
    "section": "Design System",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "grid-table",
    "storyTitle": "Design System/Data Display/Grid Table"
  },
  {
    "id": "key-value-grid",
    "label": "Key Value Grid",
    "sourcePath": "packages/design-system/components/ui/primitives/key-value-grid.tsx",
    "section": "Design System",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "key-value-grid",
    "storyTitle": "Design System/Data Display/Key Value Grid"
  },
  {
    "id": "line-chart",
    "label": "Line Chart",
    "sourcePath": "packages/design-system/components/ui/primitives/line-chart.tsx",
    "section": "Design System",
    "pathSegments": [
      "Data Display",
      "Data Visualization"
    ],
    "storyId": "line-chart",
    "storyTitle": "Design System/Data Display/Data Visualization/Line Chart"
  },
  {
    "id": "match-list",
    "label": "Match List",
    "sourcePath": "packages/design-system/components/ui/primitives/match-list.tsx",
    "section": "Design System",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "match-list",
    "storyTitle": "Design System/Data Display/Match List"
  },
  {
    "id": "metadata-panel",
    "label": "Metadata Panel",
    "sourcePath": "packages/design-system/components/ui/metadata-panel.tsx",
    "section": "Design System",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "metadata-panel",
    "storyTitle": "Design System/Data Display/Metadata Panel"
  },
  {
    "id": "metric-card",
    "label": "Metric Card",
    "sourcePath": "packages/design-system/components/ui/primitives/metric-card.tsx",
    "section": "Design System",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "metric-card",
    "storyTitle": "Design System/Data Display/Metric Card"
  },
  {
    "id": "priority-badge",
    "label": "Priority Badge",
    "sourcePath": "packages/design-system/components/ui/priority-badge.tsx",
    "section": "Design System",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "priority-badge",
    "storyTitle": "Design System/Data Display/Priority Badge"
  },
  {
    "id": "priority-icon",
    "label": "Priority Icon",
    "sourcePath": "packages/design-system/components/ui/priority-icon.tsx",
    "section": "Design System",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "priority-icon",
    "storyTitle": "Design System/Data Display/Priority Icon"
  },
  {
    "id": "ranked-bar",
    "label": "Ranked Bar",
    "sourcePath": "packages/design-system/components/ui/primitives/ranked-bar.tsx",
    "section": "Design System",
    "pathSegments": [
      "Data Display",
      "Data Visualization"
    ],
    "storyId": "ranked-bar",
    "storyTitle": "Design System/Data Display/Data Visualization/Ranked Bar"
  },
  {
    "id": "sankey-graph",
    "label": "Sankey Graph",
    "sourcePath": "packages/design-system/components/ui/primitives/sankey-graph.tsx",
    "section": "Design System",
    "pathSegments": [
      "Data Display",
      "Data Visualization"
    ],
    "storyId": "sankey-graph",
    "storyTitle": "Design System/Data Display/Data Visualization/Sankey Graph"
  },
  {
    "id": "segmented-bar",
    "label": "Segmented Bar",
    "sourcePath": "packages/design-system/components/ui/primitives/segmented-bar.tsx",
    "section": "Design System",
    "pathSegments": [
      "Data Display",
      "Data Visualization"
    ],
    "storyId": "segmented-bar",
    "storyTitle": "Design System/Data Display/Data Visualization/Segmented Bar"
  },
  {
    "id": "sortable-column-header",
    "label": "Sortable Column Header",
    "sourcePath": "packages/design-system/components/ui/sortable-column-header.tsx",
    "section": "Design System",
    "pathSegments": [
      "Data Display",
      "Tables"
    ],
    "storyId": "sortable-column-header",
    "storyTitle": "Design System/Data Display/Tables/Sortable Column Header"
  },
  {
    "id": "sparkline",
    "label": "Sparkline",
    "sourcePath": "packages/design-system/components/ui/primitives/sparkline.tsx",
    "section": "Design System",
    "pathSegments": [
      "Data Display",
      "Data Visualization"
    ],
    "storyId": "sparkline",
    "storyTitle": "Design System/Data Display/Data Visualization/Sparkline"
  },
  {
    "id": "status-icon",
    "label": "Status Icon",
    "sourcePath": "packages/design-system/components/ui/status-icon.tsx",
    "section": "Design System",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "status-icon",
    "storyTitle": "Design System/Data Display/Status Icon"
  },
  {
    "id": "status-percentage-icon",
    "label": "Status Percentage Icon",
    "sourcePath": "packages/design-system/components/ui/status-percentage-icon.tsx",
    "section": "Design System",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "status-percentage-icon",
    "storyTitle": "Design System/Data Display/Status Percentage Icon"
  },
  {
    "id": "table",
    "label": "Table",
    "sourcePath": "packages/design-system/components/ui/table.tsx",
    "section": "Design System",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "table",
    "storyTitle": "Design System/Data Display/Table"
  },
  {
    "id": "table-filter-menu",
    "label": "Table Filter Menu",
    "sourcePath": "packages/design-system/components/ui/table-filter-menu.tsx",
    "section": "Design System",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "table-filter-menu",
    "storyTitle": "Design System/Data Display/Table Filter Menu"
  },
  {
    "id": "table-grid-column-menu",
    "label": "Table Grid Column Menu",
    "sourcePath": "packages/design-system/components/ui/table-grid-column-menu.tsx",
    "section": "Design System",
    "pathSegments": [
      "Data Display",
      "Tables"
    ],
    "storyId": "table-grid-column-menu",
    "storyTitle": "Design System/Data Display/Tables/Table Grid Column Menu"
  },
  {
    "id": "table-grid-header",
    "label": "Table Grid Header",
    "sourcePath": "packages/design-system/components/ui/table-grid-header.tsx",
    "section": "Design System",
    "pathSegments": [
      "Data Display",
      "Tables"
    ],
    "storyId": "table-grid-header",
    "storyTitle": "Design System/Data Display/Tables/Table Grid Header"
  },
  {
    "id": "table-grid-header-handles",
    "label": "Table Grid Header Handles",
    "sourcePath": "packages/design-system/components/ui/table-grid-header-handles.tsx",
    "section": "Design System",
    "pathSegments": [
      "Data Display",
      "Tables"
    ],
    "storyId": "table-grid-header-handles",
    "storyTitle": "Design System/Data Display/Tables/Table Grid Header Handles"
  },
  {
    "id": "table-page-size-select",
    "label": "Table Page Size Select",
    "sourcePath": "packages/design-system/components/ui/table-page-size-select.tsx",
    "section": "Design System",
    "pathSegments": [
      "Data Display",
      "Tables"
    ],
    "storyId": "table-page-size-select",
    "storyTitle": "Design System/Data Display/Tables/Table Page Size Select"
  },
  {
    "id": "table-pagination",
    "label": "Table Pagination",
    "sourcePath": "packages/design-system/components/ui/table-pagination.tsx",
    "section": "Design System",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "table-pagination",
    "storyTitle": "Design System/Data Display/Table Pagination"
  },
  {
    "id": "table-pagination-footer",
    "label": "Table Pagination Footer",
    "sourcePath": "packages/design-system/components/ui/table-pagination-footer.tsx",
    "section": "Design System",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "table-pagination-footer",
    "storyTitle": "Design System/Data Display/Table Pagination Footer"
  },
  {
    "id": "table-placeholder-actions",
    "label": "Table Placeholder Actions",
    "sourcePath": "packages/design-system/components/ui/table-placeholder-actions.tsx",
    "section": "Design System",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "table-placeholder-actions",
    "storyTitle": "Design System/Data Display/Table Placeholder Actions"
  },
  {
    "id": "table-saved-views-switcher",
    "label": "Table Saved Views Switcher",
    "sourcePath": "packages/design-system/components/ui/table-saved-views-switcher.tsx",
    "section": "Design System",
    "pathSegments": [
      "Data Display",
      "Tables"
    ],
    "storyId": "table-saved-views-switcher",
    "storyTitle": "Design System/Data Display/Tables/Table Saved Views Switcher"
  },
  {
    "id": "table-view-menu",
    "label": "Table View Menu",
    "sourcePath": "packages/design-system/components/ui/table-view-menu.tsx",
    "section": "Design System",
    "pathSegments": [
      "Data Display",
      "Tables"
    ],
    "storyId": "table-view-menu",
    "storyTitle": "Design System/Data Display/Tables/Table View Menu"
  },
  {
    "id": "time-series-area-chart",
    "label": "Time Series Area Chart",
    "sourcePath": "packages/design-system/components/ui/time-series-area-chart.tsx",
    "section": "Design System",
    "pathSegments": [
      "Data Display",
      "Data Visualization"
    ],
    "storyId": "time-series-area-chart",
    "storyTitle": "Design System/Data Display/Data Visualization/Time Series Area Chart"
  },
  {
    "id": "tone-label",
    "label": "Tone Label",
    "sourcePath": "packages/design-system/components/ui/tone-label.tsx",
    "section": "Design System",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "tone-label",
    "storyTitle": "Design System/Data Display/Tone Label"
  },
  {
    "id": "code-block",
    "label": "Code Block",
    "sourcePath": "packages/design-system/components/ui/primitives/code-block.tsx",
    "section": "Design System",
    "pathSegments": [
      "Documents & Conversation"
    ],
    "storyId": "code-block",
    "storyTitle": "Design System/Documents & Conversation/Code Block"
  },
  {
    "id": "collapsed-comment-row",
    "label": "Collapsed Comment Row",
    "sourcePath": "packages/design-system/components/ui/collapsed-comment-row.tsx",
    "section": "Design System",
    "pathSegments": [
      "Documents & Conversation"
    ],
    "storyId": "collapsed-comment-row",
    "storyTitle": "Design System/Documents & Conversation/Collapsed Comment Row"
  },
  {
    "id": "comment-action-menu",
    "label": "Comment Action Menu",
    "sourcePath": "packages/design-system/components/ui/comment-action-menu.tsx",
    "section": "Design System",
    "pathSegments": [
      "Documents & Conversation"
    ],
    "storyId": "comment-action-menu",
    "storyTitle": "Design System/Documents & Conversation/Comment Action Menu"
  },
  {
    "id": "comment-composer",
    "label": "Comment Composer",
    "sourcePath": "packages/design-system/components/ui/comment-composer.tsx",
    "section": "Design System",
    "pathSegments": [
      "Documents & Conversation"
    ],
    "storyId": "comment-composer",
    "storyTitle": "Design System/Documents & Conversation/Comment Composer"
  },
  {
    "id": "comment-thread",
    "label": "Comment Thread",
    "sourcePath": "packages/design-system/components/ui/comment-thread.tsx",
    "section": "Design System",
    "pathSegments": [
      "Documents & Conversation"
    ],
    "storyId": "comment-thread",
    "storyTitle": "Design System/Documents & Conversation/Comment Thread"
  },
  {
    "id": "comment-thread-action-footer",
    "label": "Comment Thread Action Footer",
    "sourcePath": "packages/design-system/components/ui/comment-thread-action-footer.tsx",
    "section": "Design System",
    "pathSegments": [
      "Documents & Conversation"
    ],
    "storyId": "comment-thread-action-footer",
    "storyTitle": "Design System/Documents & Conversation/Comment Thread Action Footer"
  },
  {
    "id": "conversation-message",
    "label": "Conversation Message",
    "sourcePath": "packages/design-system/components/ui/conversation-message.tsx",
    "section": "Design System",
    "pathSegments": [
      "Documents & Conversation"
    ],
    "storyId": "conversation-message",
    "storyTitle": "Design System/Documents & Conversation/Conversation Message"
  },
  {
    "id": "conversation-transcript",
    "label": "Conversation Transcript",
    "sourcePath": "packages/design-system/components/ui/conversation-transcript.tsx",
    "section": "Design System",
    "pathSegments": [
      "Documents & Conversation"
    ],
    "storyId": "conversation-transcript",
    "storyTitle": "Design System/Documents & Conversation/Conversation Transcript"
  },
  {
    "id": "feed-rail",
    "label": "Feed Rail",
    "sourcePath": "packages/design-system/components/ui/feed-rail.tsx",
    "section": "Design System",
    "pathSegments": [
      "Documents & Conversation"
    ],
    "storyId": "feed-rail",
    "storyTitle": "Design System/Documents & Conversation/Feed Rail"
  },
  {
    "id": "inline-edit-editor-shell",
    "label": "Inline Edit Editor Shell",
    "sourcePath": "packages/design-system/components/ui/inline-edit-editor-shell.tsx",
    "section": "Design System",
    "pathSegments": [
      "Documents & Conversation"
    ],
    "storyId": "inline-edit-editor-shell",
    "storyTitle": "Design System/Documents & Conversation/Inline Edit Editor Shell"
  },
  {
    "id": "markdown-content",
    "label": "Markdown Content",
    "sourcePath": "packages/design-system/components/ui/primitives/markdown-content.tsx",
    "section": "Design System",
    "pathSegments": [
      "Documents & Conversation"
    ],
    "storyId": "markdown-content",
    "storyTitle": "Design System/Documents & Conversation/Markdown Content"
  },
  {
    "id": "terminal-block",
    "label": "Terminal Block",
    "sourcePath": "packages/design-system/components/ui/primitives/terminal-block.tsx",
    "section": "Design System",
    "pathSegments": [
      "Documents & Conversation"
    ],
    "storyId": "terminal-block",
    "storyTitle": "Design System/Documents & Conversation/Terminal Block"
  },
  {
    "id": "unified-diff",
    "label": "Unified Diff",
    "sourcePath": "packages/design-system/components/ui/primitives/unified-diff.tsx",
    "section": "Design System",
    "pathSegments": [
      "Documents & Conversation"
    ],
    "storyId": "unified-diff",
    "storyTitle": "Design System/Documents & Conversation/Unified Diff"
  },
  {
    "id": "status-metadata-section",
    "label": "Status Metadata Section",
    "sourcePath": "packages/design-system/components/ui/status-metadata-section.tsx",
    "section": "Design System",
    "pathSegments": [
      "Configuration & Admin"
    ],
    "storyId": "status-metadata-section",
    "storyTitle": "Design System/Configuration & Admin/Status Metadata Section"
  }
] as const satisfies readonly StorybookCatalogEntry[];

export const appComponentCatalog =
  [
  {
    "id": "backend-mismatch-modal",
    "label": "Backend Mismatch Modal",
    "sourcePath": "packages/app/compute/components/backend-mismatch-modal.tsx",
    "section": "Design System",
    "pathSegments": [
      "Overlays"
    ],
    "storyId": "backend-mismatch-modal",
    "storyTitle": "Design System/Overlays/Backend Mismatch Modal"
  },
  {
    "id": "confirmation-dialog",
    "label": "Confirmation Dialog",
    "sourcePath": "packages/app/shared/components/confirmation-dialog.tsx",
    "section": "Design System",
    "pathSegments": [
      "Overlays"
    ],
    "storyId": "confirmation-dialog",
    "storyTitle": "Design System/Overlays/Confirmation Dialog"
  },
  {
    "id": "delete-confirmation-dialog",
    "label": "Delete Confirmation Dialog",
    "sourcePath": "packages/app/shared/components/delete-confirmation-dialog.tsx",
    "section": "Design System",
    "pathSegments": [
      "Overlays"
    ],
    "storyId": "delete-confirmation-dialog",
    "storyTitle": "Design System/Overlays/Delete Confirmation Dialog"
  },
  {
    "id": "friendly-error-alert",
    "label": "Friendly Error Alert",
    "sourcePath": "packages/app/shared/components/friendly-error-alert.tsx",
    "section": "Design System",
    "pathSegments": [
      "Feedback & Status"
    ],
    "storyId": "friendly-error-alert",
    "storyTitle": "Design System/Feedback & Status/Friendly Error Alert"
  },
  {
    "id": "page-loading-spinner",
    "label": "Page Loading Spinner",
    "sourcePath": "packages/app/shared/components/page-loading-spinner.tsx",
    "section": "Design System",
    "pathSegments": [
      "Feedback & Status"
    ],
    "storyId": "page-loading-spinner",
    "storyTitle": "Design System/Feedback & Status/Page Loading Spinner"
  }
] as const satisfies readonly StorybookCatalogEntry[];

export const appCoreComponentCatalog =
  [
  {
    "id": "agent-session-detail-analytics-tabs",
    "label": "Agent Session Detail Analytics Tabs",
    "sourcePath": "packages/app/agents/components/detail/agent-session-detail-analytics-tabs.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Detail"
    ],
    "storyId": "agent-session-detail-analytics-tabs",
    "storyTitle": "App Core/Agents/Detail/Agent Session Detail Analytics Tabs"
  },
  {
    "id": "agent-session-detail-states",
    "label": "Agent Session Detail States",
    "sourcePath": "packages/app/agents/components/detail/agent-session-detail-states.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Detail"
    ],
    "storyId": "agent-session-detail-states",
    "storyTitle": "App Core/Agents/Detail/Agent Session Detail States"
  },
  {
    "id": "error-propagation-map",
    "label": "Error Propagation Map",
    "sourcePath": "packages/app/agents/components/detail/error-propagation-map.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Detail"
    ],
    "storyId": "error-propagation-map",
    "storyTitle": "App Core/Agents/Detail/Error Propagation Map"
  },
  {
    "id": "property-values",
    "label": "Property Value",
    "sourcePath": "packages/app/agents/components/detail/property-values.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Detail"
    ],
    "storyId": "property-values",
    "storyTitle": "App Core/Agents/Detail/Property Value"
  },
  {
    "id": "session-activity-breakdown",
    "label": "Session Activity Breakdown",
    "sourcePath": "packages/app/agents/components/detail/session-activity-breakdown.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Detail"
    ],
    "storyId": "session-activity-breakdown",
    "storyTitle": "App Core/Agents/Detail/Session Activity Breakdown"
  },
  {
    "id": "session-comments-rail",
    "label": "Session Comments Rail",
    "sourcePath": "packages/app/agents/components/detail/session-comments-rail.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Detail"
    ],
    "storyId": "session-comments-rail",
    "storyTitle": "App Core/Agents/Detail/Session Comments Rail"
  },
  {
    "id": "agent-session-detail-view",
    "label": "Session Detail",
    "sourcePath": "packages/app/agents/components/detail/agent-session-detail-view.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Detail"
    ],
    "storyId": "agent-session-detail-view",
    "storyTitle": "App Core/Agents/Detail/Session Detail"
  },
  {
    "id": "agent-orchestration-graph",
    "label": "Session Detail Orchestration Graph",
    "sourcePath": "packages/app/agents/components/detail/agent-orchestration-graph.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Detail"
    ],
    "storyId": "agent-orchestration-graph",
    "storyTitle": "App Core/Agents/Detail/Session Detail Orchestration Graph"
  },
  {
    "id": "session-detail-panels",
    "label": "Session Detail Panels",
    "sourcePath": "packages/app/agents/components/detail/session-detail-panels.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Detail"
    ],
    "storyId": "session-detail-panels",
    "storyTitle": "App Core/Agents/Detail/Session Detail Panels"
  },
  {
    "id": "session-duration-property",
    "label": "Session Duration Property",
    "sourcePath": "packages/app/agents/components/detail/session-duration-property.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Detail"
    ],
    "storyId": "session-duration-property",
    "storyTitle": "App Core/Agents/Detail/Session Duration Property"
  },
  {
    "id": "session-flagged-properties",
    "label": "Session Flagged Properties",
    "sourcePath": "packages/app/agents/components/detail/session-flagged-properties.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Detail"
    ],
    "storyId": "session-flagged-properties",
    "storyTitle": "App Core/Agents/Detail/Session Flagged Properties"
  },
  {
    "id": "session-linked-artifacts-row",
    "label": "Session Linked Artifacts Row",
    "sourcePath": "packages/app/agents/components/detail/session-linked-artifacts-row.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Detail"
    ],
    "storyId": "session-linked-artifacts-row",
    "storyTitle": "App Core/Agents/Detail/Session Linked Artifacts Row"
  },
  {
    "id": "session-loc-per-dollar-property",
    "label": "Session LOC Per Dollar Property",
    "sourcePath": "packages/app/agents/components/detail/session-loc-per-dollar-property.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Detail"
    ],
    "storyId": "session-loc-per-dollar-property",
    "storyTitle": "App Core/Agents/Detail/Session LOC Per Dollar Property"
  },
  {
    "id": "session-measured-properties",
    "label": "Session Measured Properties",
    "sourcePath": "packages/app/agents/components/detail/session-measured-properties.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Detail"
    ],
    "storyId": "session-measured-properties",
    "storyTitle": "App Core/Agents/Detail/Session Measured Properties"
  },
  {
    "id": "session-output-diff",
    "label": "Session Output Diff",
    "sourcePath": "packages/app/agents/components/detail/session-output-diff.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Detail"
    ],
    "storyId": "session-output-diff",
    "storyTitle": "App Core/Agents/Detail/Session Output Diff"
  },
  {
    "id": "session-properties-panel",
    "label": "Session Properties Panel",
    "sourcePath": "packages/app/agents/components/detail/session-properties-panel.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Detail"
    ],
    "storyId": "session-properties-panel",
    "storyTitle": "App Core/Agents/Detail/Session Properties Panel"
  },
  {
    "id": "session-pull-request-pill",
    "label": "Session Pull Request Pill",
    "sourcePath": "packages/app/agents/components/detail/session-pull-request-pill.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Detail"
    ],
    "storyId": "session-pull-request-pill",
    "storyTitle": "App Core/Agents/Detail/Session Pull Request Pill"
  },
  {
    "id": "session-pull-requests-row",
    "label": "Session Pull Requests Row",
    "sourcePath": "packages/app/agents/components/detail/session-pull-requests-row.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Detail"
    ],
    "storyId": "session-pull-requests-row",
    "storyTitle": "App Core/Agents/Detail/Session Pull Requests Row"
  },
  {
    "id": "session-transcript-panel",
    "label": "Session Transcript Panel",
    "sourcePath": "packages/app/agents/components/detail/session-transcript-panel.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Detail"
    ],
    "storyId": "session-transcript-panel",
    "storyTitle": "App Core/Agents/Detail/Session Transcript Panel"
  },
  {
    "id": "subagent-effectiveness-panel",
    "label": "Subagent Effectiveness Panel",
    "sourcePath": "packages/app/agents/components/detail/subagent-effectiveness-panel.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Detail"
    ],
    "storyId": "subagent-effectiveness-panel",
    "storyTitle": "App Core/Agents/Detail/Subagent Effectiveness Panel"
  },
  {
    "id": "transcript-file-switcher",
    "label": "Transcript File Switcher",
    "sourcePath": "packages/app/agents/components/detail/transcript-file-switcher.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Detail"
    ],
    "storyId": "transcript-file-switcher",
    "storyTitle": "App Core/Agents/Detail/Transcript File Switcher"
  },
  {
    "id": "transcript-force-archive-action",
    "label": "Transcript Force Archive Action",
    "sourcePath": "packages/app/agents/components/detail/transcript-force-archive-action.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Detail"
    ],
    "storyId": "transcript-force-archive-action",
    "storyTitle": "App Core/Agents/Detail/Transcript Force Archive Action"
  },
  {
    "id": "viewport-tooltip",
    "label": "Viewport Tooltip",
    "sourcePath": "packages/app/agents/components/detail/viewport-tooltip.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Detail"
    ],
    "storyId": "viewport-tooltip",
    "storyTitle": "App Core/Agents/Detail/Viewport Tooltip"
  },
  {
    "id": "agent-card",
    "label": "Agent Card",
    "sourcePath": "packages/app/agents/components/agent-card.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Overview"
    ],
    "storyId": "agent-card",
    "storyTitle": "App Core/Agents/Overview/Agent Card"
  },
  {
    "id": "agent-collaboration-network",
    "label": "Agent Collaboration Network",
    "sourcePath": "packages/app/agents/components/agent-collaboration-network.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Overview"
    ],
    "storyId": "agent-collaboration-network",
    "storyTitle": "App Core/Agents/Overview/Agent Collaboration Network"
  },
  {
    "id": "orchestration-dag",
    "label": "Agent Orchestration Graph",
    "sourcePath": "packages/app/agents/components/orchestration-dag.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Overview"
    ],
    "storyId": "orchestration-dag",
    "storyTitle": "App Core/Agents/Overview/Agent Orchestration Graph"
  },
  {
    "id": "agent-pipeline-graph",
    "label": "Agent Pipeline Graph",
    "sourcePath": "packages/app/agents/components/agent-pipeline-graph.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Overview"
    ],
    "storyId": "agent-pipeline-graph",
    "storyTitle": "App Core/Agents/Overview/Agent Pipeline Graph"
  },
  {
    "id": "cli-tools-panel",
    "label": "Cli Tools Panel",
    "sourcePath": "packages/app/agents/components/cli-tools-panel.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Overview"
    ],
    "storyId": "cli-tools-panel",
    "storyTitle": "App Core/Agents/Overview/Cli Tools Panel"
  },
  {
    "id": "compaction-impact",
    "label": "Compaction Impact",
    "sourcePath": "packages/app/agents/components/compaction-impact.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Overview"
    ],
    "storyId": "compaction-impact",
    "storyTitle": "App Core/Agents/Overview/Compaction Impact"
  },
  {
    "id": "context-cards",
    "label": "Context Cards",
    "sourcePath": "packages/app/agents/components/analytics/context-cards.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Overview"
    ],
    "storyId": "context-cards",
    "storyTitle": "App Core/Agents/Overview/Context Cards"
  },
  {
    "id": "event-group-row",
    "label": "Event Group Row",
    "sourcePath": "packages/app/agents/components/events/event-group-row.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Overview"
    ],
    "storyId": "event-group-row",
    "storyTitle": "App Core/Agents/Overview/Event Group Row"
  },
  {
    "id": "model-usage-table",
    "label": "Model Usage Table",
    "sourcePath": "packages/app/agents/components/model-usage-table.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Overview"
    ],
    "storyId": "model-usage-table",
    "storyTitle": "App Core/Agents/Overview/Model Usage Table"
  },
  {
    "id": "agent-session-activity-feed",
    "label": "Session Activity Feed",
    "sourcePath": "packages/app/agents/components/activity/agent-session-activity-feed.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Overview"
    ],
    "storyId": "agent-session-activity-feed",
    "storyTitle": "App Core/Agents/Overview/Session Activity Feed"
  },
  {
    "id": "session-status-badges",
    "label": "Session Status Badges",
    "sourcePath": "packages/app/agents/components/session-status-badges.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Overview"
    ],
    "storyId": "session-status-badges",
    "storyTitle": "App Core/Agents/Overview/Session Status Badges"
  },
  {
    "id": "agent-telemetry-analytics",
    "label": "Telemetry Analytics",
    "sourcePath": "packages/app/agents/components/analytics/agent-telemetry-analytics.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Overview"
    ],
    "storyId": "agent-telemetry-analytics",
    "storyTitle": "App Core/Agents/Overview/Telemetry Analytics"
  },
  {
    "id": "thinking-block",
    "label": "Thinking Block",
    "sourcePath": "packages/app/agents/components/thinking-block.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Overview"
    ],
    "storyId": "thinking-block",
    "storyTitle": "App Core/Agents/Overview/Thinking Block"
  },
  {
    "id": "user-usage-table",
    "label": "User Usage Table",
    "sourcePath": "packages/app/agents/components/user-usage-table.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Overview"
    ],
    "storyId": "user-usage-table",
    "storyTitle": "App Core/Agents/Overview/User Usage Table"
  },
  {
    "id": "active-runs-panel",
    "label": "Active Runs Panel",
    "sourcePath": "packages/app/agents/components/sessions/active-runs-panel.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Sessions"
    ],
    "storyId": "active-runs-panel",
    "storyTitle": "App Core/Agents/Sessions/Active Runs Panel"
  },
  {
    "id": "agent-sessions-list",
    "label": "Agent Sessions List",
    "sourcePath": "packages/app/agents/components/sessions/agent-sessions-list.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Sessions"
    ],
    "storyId": "agent-sessions-list",
    "storyTitle": "App Core/Agents/Sessions/Agent Sessions List"
  },
  {
    "id": "cloud-sync-state-badge",
    "label": "Cloud Sync State Badge",
    "sourcePath": "packages/app/agents/components/sessions/cloud-sync-state-badge.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Sessions"
    ],
    "storyId": "cloud-sync-state-badge",
    "storyTitle": "App Core/Agents/Sessions/Cloud Sync State Badge"
  },
  {
    "id": "cost-metric-card",
    "label": "Cost Metric Card",
    "sourcePath": "packages/app/agents/components/sessions/cost-metric-card.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Sessions"
    ],
    "storyId": "cost-metric-card",
    "storyTitle": "App Core/Agents/Sessions/Cost Metric Card"
  },
  {
    "id": "session-card",
    "label": "Session Card",
    "sourcePath": "packages/app/agents/components/sessions/session-card.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Sessions"
    ],
    "storyId": "session-card",
    "storyTitle": "App Core/Agents/Sessions/Session Card"
  },
  {
    "id": "session-cell-chips",
    "label": "Session Cell Chips",
    "sourcePath": "packages/app/agents/components/sessions/session-cell-chips.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Sessions"
    ],
    "storyId": "session-cell-chips",
    "storyTitle": "App Core/Agents/Sessions/Session Cell Chips"
  },
  {
    "id": "session-cost-cell",
    "label": "Session Cost Cell",
    "sourcePath": "packages/app/agents/components/sessions/session-cost-cell.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Sessions"
    ],
    "storyId": "session-cost-cell",
    "storyTitle": "App Core/Agents/Sessions/Session Cost Cell"
  },
  {
    "id": "session-group-icons",
    "label": "Session Group Icons",
    "sourcePath": "packages/app/agents/components/sessions/session-group-icons.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Sessions"
    ],
    "storyId": "session-group-icons",
    "storyTitle": "App Core/Agents/Sessions/Session Group Icons"
  },
  {
    "id": "session-provenance-chip",
    "label": "Session Provenance Chip",
    "sourcePath": "packages/app/agents/components/sessions/session-provenance-chip.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Sessions"
    ],
    "storyId": "session-provenance-chip",
    "storyTitle": "App Core/Agents/Sessions/Session Provenance Chip"
  },
  {
    "id": "session-sync-status-badge",
    "label": "Session Sync Status Badge",
    "sourcePath": "packages/app/agents/components/sessions/session-sync-status-badge.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Sessions"
    ],
    "storyId": "session-sync-status-badge",
    "storyTitle": "App Core/Agents/Sessions/Session Sync Status Badge"
  },
  {
    "id": "sessions-active-filters-bar",
    "label": "Sessions Active Filters Bar",
    "sourcePath": "packages/app/agents/components/sessions/sessions-active-filters-bar.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Sessions"
    ],
    "storyId": "sessions-active-filters-bar",
    "storyTitle": "App Core/Agents/Sessions/Sessions Active Filters Bar"
  },
  {
    "id": "sessions-controls",
    "label": "Sessions Controls",
    "sourcePath": "packages/app/agents/components/sessions/sessions-controls.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Sessions"
    ],
    "storyId": "sessions-controls",
    "storyTitle": "App Core/Agents/Sessions/Sessions Controls"
  },
  {
    "id": "sessions-empty-state",
    "label": "Sessions Empty State",
    "sourcePath": "packages/app/agents/components/sessions/sessions-empty-state.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Sessions"
    ],
    "storyId": "sessions-empty-state",
    "storyTitle": "App Core/Agents/Sessions/Sessions Empty State"
  },
  {
    "id": "sessions-recovery-action",
    "label": "Sessions Recovery Action",
    "sourcePath": "packages/app/agents/components/sessions/sessions-recovery-action.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Sessions"
    ],
    "storyId": "sessions-recovery-action",
    "storyTitle": "App Core/Agents/Sessions/Sessions Recovery Action"
  },
  {
    "id": "sessions-sign-in-indicator",
    "label": "Sessions Sign In Indicator",
    "sourcePath": "packages/app/agents/components/sessions/sessions-sign-in-indicator.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Sessions"
    ],
    "storyId": "sessions-sign-in-indicator",
    "storyTitle": "App Core/Agents/Sessions/Sessions Sign In Indicator"
  },
  {
    "id": "sessions-summary-cards",
    "label": "Sessions Summary Cards",
    "sourcePath": "packages/app/agents/components/sessions/sessions-summary-cards.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Sessions"
    ],
    "storyId": "sessions-summary-cards",
    "storyTitle": "App Core/Agents/Sessions/Sessions Summary Cards"
  },
  {
    "id": "sessions-summary-cards-loading",
    "label": "Sessions Summary Cards Loading",
    "sourcePath": "packages/app/agents/components/sessions/sessions-summary-cards-loading.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Sessions"
    ],
    "storyId": "sessions-summary-cards-loading",
    "storyTitle": "App Core/Agents/Sessions/Sessions Summary Cards Loading"
  },
  {
    "id": "sessions-summary-delta-slots",
    "label": "Sessions Summary Delta Slots",
    "sourcePath": "packages/app/agents/components/sessions/sessions-summary-delta-slots.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Sessions"
    ],
    "storyId": "sessions-summary-delta-slots",
    "storyTitle": "App Core/Agents/Sessions/Sessions Summary Delta Slots"
  },
  {
    "id": "sessions-table",
    "label": "Sessions Table",
    "sourcePath": "packages/app/agents/components/sessions/sessions-table.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Sessions"
    ],
    "storyId": "sessions-table",
    "storyTitle": "App Core/Agents/Sessions/Sessions Table"
  },
  {
    "id": "synced-sessions-table",
    "label": "Synced Sessions Table",
    "sourcePath": "packages/app/agents/components/sessions/synced-sessions-table.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Sessions"
    ],
    "storyId": "synced-sessions-table",
    "storyTitle": "App Core/Agents/Sessions/Synced Sessions Table"
  },
  {
    "id": "activity-bucket-tooltip",
    "label": "Activity Bucket Tooltip",
    "sourcePath": "packages/app/agents/components/detail/activity-bucket-tooltip.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Timeline"
    ],
    "storyId": "activity-bucket-tooltip",
    "storyTitle": "App Core/Agents/Timeline/Activity Bucket Tooltip"
  },
  {
    "id": "session-timeline-axis",
    "label": "Session Timeline Axis",
    "sourcePath": "packages/app/agents/components/detail/session-timeline-axis.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Timeline"
    ],
    "storyId": "session-timeline-axis",
    "storyTitle": "App Core/Agents/Timeline/Session Timeline Axis"
  },
  {
    "id": "session-timeline-bars",
    "label": "Session Timeline Bars",
    "sourcePath": "packages/app/agents/components/detail/session-timeline-bars.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Timeline"
    ],
    "storyId": "session-timeline-bars",
    "storyTitle": "App Core/Agents/Timeline/Session Timeline Bars"
  },
  {
    "id": "session-timeline-controls",
    "label": "Session Timeline Controls",
    "sourcePath": "packages/app/agents/components/detail/session-timeline-controls.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Timeline"
    ],
    "storyId": "session-timeline-controls",
    "storyTitle": "App Core/Agents/Timeline/Session Timeline Controls"
  },
  {
    "id": "session-timeline-bar-labels",
    "label": "Session Timeline Cost Rail",
    "sourcePath": "packages/app/agents/components/detail/session-timeline-bar-labels.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Timeline"
    ],
    "storyId": "session-timeline-bar-labels",
    "storyTitle": "App Core/Agents/Timeline/Session Timeline Cost Rail"
  },
  {
    "id": "session-timeline-dot-rail",
    "label": "Session Timeline Dot Rail",
    "sourcePath": "packages/app/agents/components/detail/session-timeline-dot-rail.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Timeline"
    ],
    "storyId": "session-timeline-dot-rail",
    "storyTitle": "App Core/Agents/Timeline/Session Timeline Dot Rail"
  },
  {
    "id": "session-timeline-strip-parts",
    "label": "Session Timeline Event Dot Tooltip",
    "sourcePath": "packages/app/agents/components/detail/session-timeline-strip-parts.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Timeline"
    ],
    "storyId": "session-timeline-strip-parts",
    "storyTitle": "App Core/Agents/Timeline/Session Timeline Event Dot Tooltip"
  },
  {
    "id": "session-timeline-summary",
    "label": "Session Timeline Summary",
    "sourcePath": "packages/app/agents/components/detail/session-timeline-summary.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Timeline"
    ],
    "storyId": "session-timeline-summary",
    "storyTitle": "App Core/Agents/Timeline/Session Timeline Summary"
  },
  {
    "id": "session-trace",
    "label": "Session Trace",
    "sourcePath": "packages/app/agents/components/detail/session-trace.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Timeline"
    ],
    "storyId": "session-trace",
    "storyTitle": "App Core/Agents/Timeline/Session Trace"
  },
  {
    "id": "session-trace-subagent",
    "label": "Session Trace Subagent",
    "sourcePath": "packages/app/agents/components/detail/session-trace-subagent.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Timeline"
    ],
    "storyId": "session-trace-subagent",
    "storyTitle": "App Core/Agents/Timeline/Session Trace Subagent"
  },
  {
    "id": "session-trace-tool-row-detail",
    "label": "Session Trace Tool Row Detail",
    "sourcePath": "packages/app/agents/components/detail/session-trace-tool-row-detail.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Timeline"
    ],
    "storyId": "session-trace-tool-row-detail",
    "storyTitle": "App Core/Agents/Timeline/Session Trace Tool Row Detail"
  },
  {
    "id": "tool-execution-flow",
    "label": "Tool Execution Flow",
    "sourcePath": "packages/app/agents/components/detail/tool-execution-flow.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Timeline"
    ],
    "storyId": "tool-execution-flow",
    "storyTitle": "App Core/Agents/Timeline/Tool Execution Flow"
  },
  {
    "id": "trace-comments-rail",
    "label": "Trace Comments Rail",
    "sourcePath": "packages/app/agents/components/detail/trace-comments-rail.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Timeline"
    ],
    "storyId": "trace-comments-rail",
    "storyTitle": "App Core/Agents/Timeline/Trace Comments Rail"
  },
  {
    "id": "trace-event-row",
    "label": "Trace Event Row",
    "sourcePath": "packages/app/agents/components/detail/trace-event-row.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Timeline"
    ],
    "storyId": "trace-event-row",
    "storyTitle": "App Core/Agents/Timeline/Trace Event Row"
  },
  {
    "id": "trace-markdown",
    "label": "Trace Markdown",
    "sourcePath": "packages/app/agents/components/detail/trace-markdown.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Timeline"
    ],
    "storyId": "trace-markdown",
    "storyTitle": "App Core/Agents/Timeline/Trace Markdown"
  },
  {
    "id": "trace-message-body",
    "label": "Trace Message Body",
    "sourcePath": "packages/app/agents/components/detail/trace-message-body.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Timeline"
    ],
    "storyId": "trace-message-body",
    "storyTitle": "App Core/Agents/Timeline/Trace Message Body"
  },
  {
    "id": "trace-harness-tags",
    "label": "Trace Tag Chip",
    "sourcePath": "packages/app/agents/components/detail/trace-harness-tags.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Timeline"
    ],
    "storyId": "trace-harness-tags",
    "storyTitle": "App Core/Agents/Timeline/Trace Tag Chip"
  },
  {
    "id": "tool-call-block",
    "label": "Tool Call Block",
    "sourcePath": "packages/app/agents/components/tools/tool-call-block.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Tools"
    ],
    "storyId": "tool-call-block",
    "storyTitle": "App Core/Agents/Tools/Tool Call Block"
  },
  {
    "id": "tool-data-view",
    "label": "Tool Data View",
    "sourcePath": "packages/app/agents/components/tools/tool-data-view.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Tools"
    ],
    "storyId": "tool-data-view",
    "storyTitle": "App Core/Agents/Tools/Tool Data View"
  },
  {
    "id": "tool-result-block",
    "label": "Tool Result Block",
    "sourcePath": "packages/app/agents/components/tools/tool-result-block.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Tools"
    ],
    "storyId": "tool-result-block",
    "storyTitle": "App Core/Agents/Tools/Tool Result Block"
  },
  {
    "id": "agent-detail",
    "label": "Agent Detail",
    "sourcePath": "packages/app/agents/components/workspace/agent-detail.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Workspace"
    ],
    "storyId": "agent-detail",
    "storyTitle": "App Core/Agents/Workspace/Agent Detail"
  },
  {
    "id": "agents-table",
    "label": "Agents Table",
    "sourcePath": "packages/app/agents/components/workspace/agents-table.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Workspace"
    ],
    "storyId": "agents-table",
    "storyTitle": "App Core/Agents/Workspace/Agents Table"
  },
  {
    "id": "agents-type-tab-strip",
    "label": "Agents Type Tab Strip",
    "sourcePath": "packages/app/agents/components/workspace/agents-type-tab-strip.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Workspace"
    ],
    "storyId": "agents-type-tab-strip",
    "storyTitle": "App Core/Agents/Workspace/Agents Type Tab Strip"
  },
  {
    "id": "detail-branches-tab",
    "label": "Detail Branches Tab",
    "sourcePath": "packages/app/agents/components/workspace/detail-branches-tab.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Workspace"
    ],
    "storyId": "detail-branches-tab",
    "storyTitle": "App Core/Agents/Workspace/Detail Branches Tab"
  },
  {
    "id": "detail-sessions-tab",
    "label": "Detail Sessions Tab",
    "sourcePath": "packages/app/agents/components/workspace/detail-sessions-tab.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Workspace"
    ],
    "storyId": "detail-sessions-tab",
    "storyTitle": "App Core/Agents/Workspace/Detail Sessions Tab"
  },
  {
    "id": "invocation-evidence-list",
    "label": "Invocation Evidence List",
    "sourcePath": "packages/app/agents/components/workspace/invocation-evidence-list.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Workspace"
    ],
    "storyId": "invocation-evidence-list",
    "storyTitle": "App Core/Agents/Workspace/Invocation Evidence List"
  },
  {
    "id": "loc-per-dollar-cell",
    "label": "LOC Per Dollar Column Value",
    "sourcePath": "packages/app/agents/components/workspace/loc-per-dollar-cell.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Workspace"
    ],
    "storyId": "loc-per-dollar-cell",
    "storyTitle": "App Core/Agents/Workspace/LOC Per Dollar Column Value"
  },
  {
    "id": "token-trend-chart",
    "label": "Token Trend Chart",
    "sourcePath": "packages/app/agents/components/workspace/token-trend-chart.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents",
      "Workspace"
    ],
    "storyId": "token-trend-chart",
    "storyTitle": "App Core/Agents/Workspace/Token Trend Chart"
  },
  {
    "id": "branch-cost-to-merge",
    "label": "Branch Cost to Merge",
    "sourcePath": "packages/app/branches/components/branch-cost-to-merge.tsx",
    "section": "App Core",
    "pathSegments": [
      "Branches"
    ],
    "storyId": "branch-cost-to-merge",
    "storyTitle": "App Core/Branches/Branch Cost to Merge"
  },
  {
    "id": "branch-delivered-panel",
    "label": "Branch Delivered Panel",
    "sourcePath": "packages/app/branches/components/detail/branch-delivered-panel.tsx",
    "section": "App Core",
    "pathSegments": [
      "Branches"
    ],
    "storyId": "branch-delivered-panel",
    "storyTitle": "App Core/Branches/Branch Delivered Panel"
  },
  {
    "id": "branch-detail-page",
    "label": "Branch Detail Page",
    "sourcePath": "packages/app/branches/components/branch-detail-page.tsx",
    "section": "App Core",
    "pathSegments": [
      "Branches"
    ],
    "storyId": "branch-detail-page",
    "storyTitle": "App Core/Branches/Branch Detail Page"
  },
  {
    "id": "branch-files-changed-panel",
    "label": "Branch Files Changed Panel",
    "sourcePath": "packages/app/branches/components/detail/branch-files-changed-panel.tsx",
    "section": "App Core",
    "pathSegments": [
      "Branches"
    ],
    "storyId": "branch-files-changed-panel",
    "storyTitle": "App Core/Branches/Branch Files Changed Panel"
  },
  {
    "id": "branch-headline-cards",
    "label": "Branch Headline Cards",
    "sourcePath": "packages/app/branches/components/branch-headline-cards.tsx",
    "section": "App Core",
    "pathSegments": [
      "Branches"
    ],
    "storyId": "branch-headline-cards",
    "storyTitle": "App Core/Branches/Branch Headline Cards"
  },
  {
    "id": "branch-lead-time-waterfall",
    "label": "Branch Lead Time Waterfall",
    "sourcePath": "packages/app/branches/components/branch-lead-time-waterfall.tsx",
    "section": "App Core",
    "pathSegments": [
      "Branches"
    ],
    "storyId": "branch-lead-time-waterfall",
    "storyTitle": "App Core/Branches/Branch Lead Time Waterfall"
  },
  {
    "id": "branch-pr-status-panel",
    "label": "Branch PR Status Panel",
    "sourcePath": "packages/app/branches/components/detail/branch-pr-status-panel.tsx",
    "section": "App Core",
    "pathSegments": [
      "Branches"
    ],
    "storyId": "branch-pr-status-panel",
    "storyTitle": "App Core/Branches/Branch PR Status Panel"
  },
  {
    "id": "branch-properties-panel",
    "label": "Branch Properties Panel",
    "sourcePath": "packages/app/branches/components/branch-properties-panel.tsx",
    "section": "App Core",
    "pathSegments": [
      "Branches"
    ],
    "storyId": "branch-properties-panel",
    "storyTitle": "App Core/Branches/Branch Properties Panel"
  },
  {
    "id": "branch-selected-pull-request-workspace",
    "label": "Branch Selected Pull Request Workspace",
    "sourcePath": "packages/app/branches/components/detail/branch-selected-pull-request-workspace.tsx",
    "section": "App Core",
    "pathSegments": [
      "Branches"
    ],
    "storyId": "branch-selected-pull-request-workspace",
    "storyTitle": "App Core/Branches/Branch Selected Pull Request Workspace"
  },
  {
    "id": "branch-sessions-timeline-tab",
    "label": "Branch Sessions Timeline Tab",
    "sourcePath": "packages/app/branches/components/detail/branch-sessions-timeline-tab.tsx",
    "section": "App Core",
    "pathSegments": [
      "Branches"
    ],
    "storyId": "branch-sessions-timeline-tab",
    "storyTitle": "App Core/Branches/Branch Sessions Timeline Tab"
  },
  {
    "id": "branches-list-body",
    "label": "Branches List Body",
    "sourcePath": "packages/app/branches/components/branches-list-body.tsx",
    "section": "App Core",
    "pathSegments": [
      "Branches"
    ],
    "storyId": "branches-list-body",
    "storyTitle": "App Core/Branches/Branches List Body"
  },
  {
    "id": "branches-summary-cards",
    "label": "Branches Summary Cards",
    "sourcePath": "packages/app/branches/components/branches-summary-cards.tsx",
    "section": "App Core",
    "pathSegments": [
      "Branches"
    ],
    "storyId": "branches-summary-cards",
    "storyTitle": "App Core/Branches/Branches Summary Cards"
  },
  {
    "id": "branches-table",
    "label": "Branches Table",
    "sourcePath": "packages/app/branches/components/branches-table.tsx",
    "section": "App Core",
    "pathSegments": [
      "Branches"
    ],
    "storyId": "branches-table",
    "storyTitle": "App Core/Branches/Branches Table"
  },
  {
    "id": "branches-toolbar",
    "label": "Branches Toolbar",
    "sourcePath": "packages/app/branches/components/branches-toolbar.tsx",
    "section": "App Core",
    "pathSegments": [
      "Branches"
    ],
    "storyId": "branches-toolbar",
    "storyTitle": "App Core/Branches/Branches Toolbar"
  },
  {
    "id": "branch-cell-primitives",
    "label": "Cell Primitives",
    "sourcePath": "packages/app/branches/components/branch-cell-primitives.stories.tsx",
    "section": "App Core",
    "pathSegments": [
      "Branches"
    ],
    "storyId": "branch-cell-primitives",
    "storyTitle": "App Core/Branches/Cell Primitives"
  },
  {
    "id": "branch-comment-card",
    "label": "Comment Card",
    "sourcePath": "packages/app/branches/components/comments/branch-comment-card.tsx",
    "section": "App Core",
    "pathSegments": [
      "Branches"
    ],
    "storyId": "branch-comment-card",
    "storyTitle": "App Core/Branches/Comment Card"
  },
  {
    "id": "branch-comments-rail",
    "label": "Comments Rail",
    "sourcePath": "packages/app/branches/components/comments/branch-comments-rail.tsx",
    "section": "App Core",
    "pathSegments": [
      "Branches"
    ],
    "storyId": "branch-comments-rail",
    "storyTitle": "App Core/Branches/Comments Rail"
  },
  {
    "id": "branch-comments-workspace",
    "label": "Comments Workspace",
    "sourcePath": "packages/app/branches/components/comments/branch-comments-workspace.tsx",
    "section": "App Core",
    "pathSegments": [
      "Branches"
    ],
    "storyId": "branch-comments-workspace",
    "storyTitle": "App Core/Branches/Comments Workspace"
  },
  {
    "id": "branch-event-dot-rail",
    "label": "Event Dot Rail",
    "sourcePath": "packages/app/branches/components/branch-event-dot-rail.tsx",
    "section": "App Core",
    "pathSegments": [
      "Branches"
    ],
    "storyId": "branch-event-dot-rail",
    "storyTitle": "App Core/Branches/Event Dot Rail"
  },
  {
    "id": "branch-merged-trace",
    "label": "Merged Trace",
    "sourcePath": "packages/app/branches/components/branch-merged-trace.tsx",
    "section": "App Core",
    "pathSegments": [
      "Branches"
    ],
    "storyId": "branch-merged-trace",
    "storyTitle": "App Core/Branches/Merged Trace"
  },
  {
    "id": "branch-pr-activity-timeline",
    "label": "PR Activity Timeline",
    "sourcePath": "packages/app/branches/components/branch-pr-activity-timeline.tsx",
    "section": "App Core",
    "pathSegments": [
      "Branches"
    ],
    "storyId": "branch-pr-activity-timeline",
    "storyTitle": "App Core/Branches/PR Activity Timeline"
  },
  {
    "id": "pr-comment-markdown",
    "label": "PR Description Markdown",
    "sourcePath": "packages/app/branches/components/pr-comment-markdown.tsx",
    "section": "App Core",
    "pathSegments": [
      "Branches"
    ],
    "storyId": "pr-comment-markdown",
    "storyTitle": "App Core/Branches/PR Description Markdown"
  },
  {
    "id": "branch-pr-session-swimlane",
    "label": "PR Session Swimlane",
    "sourcePath": "packages/app/branches/components/branch-pr-session-swimlane.tsx",
    "section": "App Core",
    "pathSegments": [
      "Branches"
    ],
    "storyId": "branch-pr-session-swimlane",
    "storyTitle": "App Core/Branches/PR Session Swimlane"
  },
  {
    "id": "branch-provider-availability",
    "label": "Provider Availability",
    "sourcePath": "packages/app/branches/components/comments/branch-provider-availability.tsx",
    "section": "App Core",
    "pathSegments": [
      "Branches"
    ],
    "storyId": "branch-provider-availability",
    "storyTitle": "App Core/Branches/Provider Availability"
  },
  {
    "id": "branch-pull-request-selector",
    "label": "Pull Request Selector",
    "sourcePath": "packages/app/branches/components/branch-pull-request-selector.tsx",
    "section": "App Core",
    "pathSegments": [
      "Branches"
    ],
    "storyId": "branch-pull-request-selector",
    "storyTitle": "App Core/Branches/Pull Request Selector"
  },
  {
    "id": "branch-trace-actor-avatar",
    "label": "Trace Actor Avatar",
    "sourcePath": "packages/app/branches/components/branch-trace-actor-avatar.tsx",
    "section": "App Core",
    "pathSegments": [
      "Branches"
    ],
    "storyId": "branch-trace-actor-avatar",
    "storyTitle": "App Core/Branches/Trace Actor Avatar"
  },
  {
    "id": "compute-preference-card",
    "label": "Compute Preference Card",
    "sourcePath": "packages/app/compute/components/compute-preference-card.tsx",
    "section": "App Core",
    "pathSegments": [
      "Compute"
    ],
    "storyId": "compute-preference-card",
    "storyTitle": "App Core/Compute/Compute Preference Card"
  },
  {
    "id": "compute-target-card",
    "label": "Compute Target Card",
    "sourcePath": "packages/app/compute/components/compute-target-card.tsx",
    "section": "App Core",
    "pathSegments": [
      "Compute"
    ],
    "storyId": "compute-target-card",
    "storyTitle": "App Core/Compute/Compute Target Card"
  },
  {
    "id": "compute-target-sync-table",
    "label": "Compute Target Sync Table",
    "sourcePath": "packages/app/compute/components/compute-target-sync-table.tsx",
    "section": "App Core",
    "pathSegments": [
      "Compute"
    ],
    "storyId": "compute-target-sync-table",
    "storyTitle": "App Core/Compute/Compute Target Sync Table"
  },
  {
    "id": "compute-target-system-check",
    "label": "Compute Target System Check",
    "sourcePath": "packages/app/compute/components/compute-target-system-check.tsx",
    "section": "App Core",
    "pathSegments": [
      "Compute"
    ],
    "storyId": "compute-target-system-check",
    "storyTitle": "App Core/Compute/Compute Target System Check"
  },
  {
    "id": "desktop-security",
    "label": "Desktop Security",
    "sourcePath": "packages/app/compute/components/desktop-security.tsx",
    "section": "App Core",
    "pathSegments": [
      "Compute"
    ],
    "storyId": "desktop-security",
    "storyTitle": "App Core/Compute/Desktop Security"
  },
  {
    "id": "system-check-repair-button",
    "label": "System Check Repair Button",
    "sourcePath": "packages/app/compute/components/system-check-repair-button.stories.tsx",
    "section": "App Core",
    "pathSegments": [
      "Compute"
    ],
    "storyId": "system-check-repair-button",
    "storyTitle": "App Core/Compute/System Check Repair Button"
  },
  {
    "id": "system-check-repair",
    "label": "System Check Repair Panel",
    "sourcePath": "packages/app/compute/components/system-check-repair.tsx",
    "section": "App Core",
    "pathSegments": [
      "Compute"
    ],
    "storyId": "system-check-repair",
    "storyTitle": "App Core/Compute/System Check Repair Panel"
  },
  {
    "id": "system-check-results",
    "label": "System Check Results",
    "sourcePath": "packages/app/compute/components/system-check-results.tsx",
    "section": "App Core",
    "pathSegments": [
      "Compute"
    ],
    "storyId": "system-check-results",
    "storyTitle": "App Core/Compute/System Check Results"
  },
  {
    "id": "system-check-status-badge",
    "label": "System Check Status Badge",
    "sourcePath": "packages/app/compute/components/system-check-status-badge.tsx",
    "section": "App Core",
    "pathSegments": [
      "Compute"
    ],
    "storyId": "system-check-status-badge",
    "storyTitle": "App Core/Compute/System Check Status Badge"
  },
  {
    "id": "activity-actor",
    "label": "Activity Actor",
    "sourcePath": "packages/app/documents/components/feed-sidebar/sources/activity-actor.tsx",
    "section": "App Core",
    "pathSegments": [
      "Documents"
    ],
    "storyId": "activity-actor",
    "storyTitle": "App Core/Documents/Activity Actor"
  },
  {
    "id": "activity-card-view",
    "label": "Activity Card View",
    "sourcePath": "packages/app/documents/components/feed-sidebar/sources/activity-card-view.tsx",
    "section": "App Core",
    "pathSegments": [
      "Documents"
    ],
    "storyId": "activity-card-view",
    "storyTitle": "App Core/Documents/Activity Card View"
  },
  {
    "id": "artifact-repositories-summary",
    "label": "Artifact Repositories Summary",
    "sourcePath": "packages/app/documents/components/artifact-repositories-summary.tsx",
    "section": "App Core",
    "pathSegments": [
      "Documents"
    ],
    "storyId": "artifact-repositories-summary",
    "storyTitle": "App Core/Documents/Artifact Repositories Summary"
  },
  {
    "id": "artifact-row-view",
    "label": "Artifact Row View",
    "sourcePath": "packages/app/documents/components/relationships/artifact-row-view.tsx",
    "section": "App Core",
    "pathSegments": [
      "Documents"
    ],
    "storyId": "artifact-row-view",
    "storyTitle": "App Core/Documents/Artifact Row View"
  },
  {
    "id": "artifact-run-in-flight",
    "label": "Artifact Run In Flight",
    "sourcePath": "packages/app/documents/components/artifact-run-in-flight.tsx",
    "section": "App Core",
    "pathSegments": [
      "Documents"
    ],
    "storyId": "artifact-run-in-flight",
    "storyTitle": "App Core/Documents/Artifact Run In Flight"
  },
  {
    "id": "attachment-list",
    "label": "Attachment List",
    "sourcePath": "packages/app/documents/components/attachment-list.tsx",
    "section": "App Core",
    "pathSegments": [
      "Documents"
    ],
    "storyId": "attachment-list",
    "storyTitle": "App Core/Documents/Attachment List"
  },
  {
    "id": "branches-section",
    "label": "Branches Section",
    "sourcePath": "packages/app/documents/components/relationships/branches-section.tsx",
    "section": "App Core",
    "pathSegments": [
      "Documents"
    ],
    "storyId": "branches-section",
    "storyTitle": "App Core/Documents/Branches Section"
  },
  {
    "id": "comments-section",
    "label": "Comments Section",
    "sourcePath": "packages/app/documents/components/comments-section.tsx",
    "section": "App Core",
    "pathSegments": [
      "Documents"
    ],
    "storyId": "comments-section",
    "storyTitle": "App Core/Documents/Comments Section"
  },
  {
    "id": "document-activity-section",
    "label": "Document Activity Section",
    "sourcePath": "packages/app/documents/components/document-activity-section.tsx",
    "section": "App Core",
    "pathSegments": [
      "Documents"
    ],
    "storyId": "document-activity-section",
    "storyTitle": "App Core/Documents/Document Activity Section"
  },
  {
    "id": "document-rating-section",
    "label": "Document Rating Section",
    "sourcePath": "packages/app/documents/components/document-rating-section.tsx",
    "section": "App Core",
    "pathSegments": [
      "Documents"
    ],
    "storyId": "document-rating-section",
    "storyTitle": "App Core/Documents/Document Rating Section"
  },
  {
    "id": "document-status-icon",
    "label": "Document Status Icon",
    "sourcePath": "packages/app/documents/components/document-status-icon.tsx",
    "section": "App Core",
    "pathSegments": [
      "Documents"
    ],
    "storyId": "document-status-icon",
    "storyTitle": "App Core/Documents/Document Status Icon"
  },
  {
    "id": "document-type-badge",
    "label": "Document Type Badge",
    "sourcePath": "packages/app/documents/components/document-type-badge.tsx",
    "section": "App Core",
    "pathSegments": [
      "Documents"
    ],
    "storyId": "document-type-badge",
    "storyTitle": "App Core/Documents/Document Type Badge"
  },
  {
    "id": "evaluation-section-view",
    "label": "Evaluation Section View",
    "sourcePath": "packages/app/documents/components/evaluation-section-view.tsx",
    "section": "App Core",
    "pathSegments": [
      "Documents"
    ],
    "storyId": "evaluation-section-view",
    "storyTitle": "App Core/Documents/Evaluation Section View"
  },
  {
    "id": "favorite-button",
    "label": "Favorite Button",
    "sourcePath": "packages/app/documents/components/favorite-button.tsx",
    "section": "App Core",
    "pathSegments": [
      "Documents"
    ],
    "storyId": "favorite-button",
    "storyTitle": "App Core/Documents/Favorite Button"
  },
  {
    "id": "issue-status-icon",
    "label": "Issue Status Icon",
    "sourcePath": "packages/app/documents/components/issue-status-icon.tsx",
    "section": "App Core",
    "pathSegments": [
      "Documents"
    ],
    "storyId": "issue-status-icon",
    "storyTitle": "App Core/Documents/Issue Status Icon"
  },
  {
    "id": "judge-result-card-view",
    "label": "Judge Result Card View",
    "sourcePath": "packages/app/documents/components/judge-result-card-view.tsx",
    "section": "App Core",
    "pathSegments": [
      "Documents"
    ],
    "storyId": "judge-result-card-view",
    "storyTitle": "App Core/Documents/Judge Result Card View"
  },
  {
    "id": "rename-dialog",
    "label": "Rename Dialog",
    "sourcePath": "packages/app/documents/components/rename-dialog.tsx",
    "section": "App Core",
    "pathSegments": [
      "Documents"
    ],
    "storyId": "rename-dialog",
    "storyTitle": "App Core/Documents/Rename Dialog"
  },
  {
    "id": "run-action-availability",
    "label": "Run Action Availability",
    "sourcePath": "packages/app/documents/components/run-action-availability.tsx",
    "section": "App Core",
    "pathSegments": [
      "Documents"
    ],
    "storyId": "run-action-availability",
    "storyTitle": "App Core/Documents/Run Action Availability"
  },
  {
    "id": "version-actions-toolbar",
    "label": "Version Actions Toolbar",
    "sourcePath": "packages/app/documents/components/version-actions-toolbar.tsx",
    "section": "App Core",
    "pathSegments": [
      "Documents"
    ],
    "storyId": "version-actions-toolbar",
    "storyTitle": "App Core/Documents/Version Actions Toolbar"
  },
  {
    "id": "kpi-delta-placeholder",
    "label": "KPI Delta Placeholder",
    "sourcePath": "packages/app/insights/components/kpi-delta-placeholder.tsx",
    "section": "App Core",
    "pathSegments": [
      "Insights"
    ],
    "storyId": "kpi-delta-placeholder",
    "storyTitle": "App Core/Insights/KPI Delta Placeholder"
  },
  {
    "id": "kpi-metric-tile",
    "label": "KPI Metric Tile",
    "sourcePath": "packages/app/insights/components/kpi-metric-tile.stories.tsx",
    "section": "App Core",
    "pathSegments": [
      "Insights"
    ],
    "storyId": "kpi-metric-tile",
    "storyTitle": "App Core/Insights/KPI Metric Tile"
  },
  {
    "id": "metric-picker",
    "label": "Metric Picker",
    "sourcePath": "packages/app/insights/components/metric-picker.tsx",
    "section": "App Core",
    "pathSegments": [
      "Insights"
    ],
    "storyId": "metric-picker",
    "storyTitle": "App Core/Insights/Metric Picker"
  },
  {
    "id": "model-usage-chart",
    "label": "Model Usage Chart",
    "sourcePath": "packages/app/insights/components/overview/model-usage-chart.tsx",
    "section": "App Core",
    "pathSegments": [
      "Insights"
    ],
    "storyId": "model-usage-chart",
    "storyTitle": "App Core/Insights/Model Usage Chart"
  },
  {
    "id": "overview-metric",
    "label": "Overview Metric",
    "sourcePath": "packages/app/insights/components/overview/overview-metric.tsx",
    "section": "App Core",
    "pathSegments": [
      "Insights"
    ],
    "storyId": "overview-metric",
    "storyTitle": "App Core/Insights/Overview Metric"
  },
  {
    "id": "tile-content",
    "label": "Tile Content",
    "sourcePath": "packages/app/insights/components/tile-content.tsx",
    "section": "App Core",
    "pathSegments": [
      "Insights"
    ],
    "storyId": "tile-content",
    "storyTitle": "App Core/Insights/Tile Content"
  },
  {
    "id": "loop-status-badge",
    "label": "Loop Status Badge",
    "sourcePath": "packages/app/loops/components/loop-status-badge.tsx",
    "section": "App Core",
    "pathSegments": [
      "Loops"
    ],
    "storyId": "loop-status-badge",
    "storyTitle": "App Core/Loops/Loop Status Badge"
  },
  {
    "id": "my-tasks-card-view",
    "label": "Card View",
    "sourcePath": "packages/app/my-tasks/components/my-tasks-card-view.tsx",
    "section": "App Core",
    "pathSegments": [
      "My Tasks"
    ],
    "storyId": "my-tasks-card-view",
    "storyTitle": "App Core/My Tasks/Card View"
  },
  {
    "id": "my-tasks-load-failed-state",
    "label": "Load Failed State",
    "sourcePath": "packages/app/my-tasks/components/my-tasks-load-failed-state.tsx",
    "section": "App Core",
    "pathSegments": [
      "My Tasks"
    ],
    "storyId": "my-tasks-load-failed-state",
    "storyTitle": "App Core/My Tasks/Load Failed State"
  },
  {
    "id": "my-tasks-pagination-footer",
    "label": "Pagination Footer",
    "sourcePath": "packages/app/my-tasks/components/my-tasks-pagination-footer.tsx",
    "section": "App Core",
    "pathSegments": [
      "My Tasks"
    ],
    "storyId": "my-tasks-pagination-footer",
    "storyTitle": "App Core/My Tasks/Pagination Footer"
  },
  {
    "id": "my-tasks-recency-empty-state",
    "label": "Recency Empty State",
    "sourcePath": "packages/app/my-tasks/components/my-tasks-recency-empty-state.tsx",
    "section": "App Core",
    "pathSegments": [
      "My Tasks"
    ],
    "storyId": "my-tasks-recency-empty-state",
    "storyTitle": "App Core/My Tasks/Recency Empty State"
  },
  {
    "id": "auth-methods",
    "label": "Auth Methods",
    "sourcePath": "packages/app/onboarding/components/auth-methods.tsx",
    "section": "App Core",
    "pathSegments": [
      "Onboarding"
    ],
    "storyId": "auth-methods",
    "storyTitle": "App Core/Onboarding/Auth Methods"
  },
  {
    "id": "auth-transition-panel",
    "label": "Auth Transition Panel",
    "sourcePath": "packages/app/onboarding/components/auth-transition-panel.tsx",
    "section": "App Core",
    "pathSegments": [
      "Onboarding"
    ],
    "storyId": "auth-transition-panel",
    "storyTitle": "App Core/Onboarding/Auth Transition Panel"
  },
  {
    "id": "desktop-undetected-notice",
    "label": "Desktop Undetected Notice",
    "sourcePath": "packages/app/onboarding/components/desktop-undetected-notice.tsx",
    "section": "App Core",
    "pathSegments": [
      "Onboarding"
    ],
    "storyId": "desktop-undetected-notice",
    "storyTitle": "App Core/Onboarding/Desktop Undetected Notice"
  },
  {
    "id": "sync-level-options",
    "label": "Sync Level Options",
    "sourcePath": "packages/app/onboarding/components/sync-level-options.stories.tsx",
    "section": "App Core",
    "pathSegments": [
      "Onboarding"
    ],
    "storyId": "sync-level-options",
    "storyTitle": "App Core/Onboarding/Sync Level Options"
  },
  {
    "id": "convert-install-sheet",
    "label": "Convert Install Sheet",
    "sourcePath": "packages/app/packs/components/convert-install-sheet.tsx",
    "section": "App Core",
    "pathSegments": [
      "Packs"
    ],
    "storyId": "convert-install-sheet",
    "storyTitle": "App Core/Packs/Convert Install Sheet"
  },
  {
    "id": "install-matrix",
    "label": "Install Matrix",
    "sourcePath": "packages/app/packs/components/install-matrix.tsx",
    "section": "App Core",
    "pathSegments": [
      "Packs"
    ],
    "storyId": "install-matrix",
    "storyTitle": "App Core/Packs/Install Matrix"
  },
  {
    "id": "install-source-label",
    "label": "Install Source Label",
    "sourcePath": "packages/app/packs/components/install-source-label.tsx",
    "section": "App Core",
    "pathSegments": [
      "Packs"
    ],
    "storyId": "install-source-label",
    "storyTitle": "App Core/Packs/Install Source Label"
  },
  {
    "id": "install-state-status",
    "label": "Install State Status",
    "sourcePath": "packages/app/packs/components/install-state-status.tsx",
    "section": "App Core",
    "pathSegments": [
      "Packs"
    ],
    "storyId": "install-state-status",
    "storyTitle": "App Core/Packs/Install State Status"
  },
  {
    "id": "member-install-control",
    "label": "Member Install Control",
    "sourcePath": "packages/app/packs/components/member-install-control.tsx",
    "section": "App Core",
    "pathSegments": [
      "Packs"
    ],
    "storyId": "member-install-control",
    "storyTitle": "App Core/Packs/Member Install Control"
  },
  {
    "id": "pack-card",
    "label": "Pack Card",
    "sourcePath": "packages/app/packs/components/pack-card.tsx",
    "section": "App Core",
    "pathSegments": [
      "Packs"
    ],
    "storyId": "pack-card",
    "storyTitle": "App Core/Packs/Pack Card"
  },
  {
    "id": "pack-detail",
    "label": "Pack Detail",
    "sourcePath": "packages/app/packs/components/pack-detail.tsx",
    "section": "App Core",
    "pathSegments": [
      "Packs"
    ],
    "storyId": "pack-detail",
    "storyTitle": "App Core/Packs/Pack Detail"
  },
  {
    "id": "pack-filter-bar",
    "label": "Pack Filter Bar",
    "sourcePath": "packages/app/packs/components/pack-filter-bar.tsx",
    "section": "App Core",
    "pathSegments": [
      "Packs"
    ],
    "storyId": "pack-filter-bar",
    "storyTitle": "App Core/Packs/Pack Filter Bar"
  },
  {
    "id": "pack-install-dialog",
    "label": "Pack Install Dialog",
    "sourcePath": "packages/app/packs/components/pack-install-dialog.tsx",
    "section": "App Core",
    "pathSegments": [
      "Packs"
    ],
    "storyId": "pack-install-dialog",
    "storyTitle": "App Core/Packs/Pack Install Dialog"
  },
  {
    "id": "packs-load-failed",
    "label": "Packs Load Failed",
    "sourcePath": "packages/app/packs/components/packs-load-failed.tsx",
    "section": "App Core",
    "pathSegments": [
      "Packs"
    ],
    "storyId": "packs-load-failed",
    "storyTitle": "App Core/Packs/Packs Load Failed"
  },
  {
    "id": "packs-workspace",
    "label": "Packs Workspace",
    "sourcePath": "packages/app/packs/components/packs-workspace.tsx",
    "section": "App Core",
    "pathSegments": [
      "Packs"
    ],
    "storyId": "packs-workspace",
    "storyTitle": "App Core/Packs/Packs Workspace"
  },
  {
    "id": "packs-workspace-skeleton",
    "label": "Packs Workspace Skeleton",
    "sourcePath": "packages/app/packs/components/packs-workspace-skeleton.tsx",
    "section": "App Core",
    "pathSegments": [
      "Packs"
    ],
    "storyId": "packs-workspace-skeleton",
    "storyTitle": "App Core/Packs/Packs Workspace Skeleton"
  },
  {
    "id": "editable-project-description",
    "label": "Editable Project Description",
    "sourcePath": "packages/app/projects/components/editable-project-description.tsx",
    "section": "App Core",
    "pathSegments": [
      "Projects"
    ],
    "storyId": "editable-project-description",
    "storyTitle": "App Core/Projects/Editable Project Description"
  },
  {
    "id": "editable-project-title",
    "label": "Editable Project Title",
    "sourcePath": "packages/app/projects/components/editable-project-title.tsx",
    "section": "App Core",
    "pathSegments": [
      "Projects"
    ],
    "storyId": "editable-project-title",
    "storyTitle": "App Core/Projects/Editable Project Title"
  },
  {
    "id": "unified-search-results",
    "label": "Unified Search Results",
    "sourcePath": "packages/app/search/components/unified-search-results.tsx",
    "section": "App Core",
    "pathSegments": [
      "Search"
    ],
    "storyId": "unified-search-results",
    "storyTitle": "App Core/Search/Unified Search Results"
  },
  {
    "id": "limit-bar",
    "label": "Limit Bar",
    "sourcePath": "packages/app/session-limits/components/limit-bar.tsx",
    "section": "App Core",
    "pathSegments": [
      "Session Limits"
    ],
    "storyId": "limit-bar",
    "storyTitle": "App Core/Session Limits/Limit Bar"
  },
  {
    "id": "session-limits-detail",
    "label": "Session Limits Detail",
    "sourcePath": "packages/app/session-limits/components/session-limits-detail.tsx",
    "section": "App Core",
    "pathSegments": [
      "Session Limits"
    ],
    "storyId": "session-limits-detail",
    "storyTitle": "App Core/Session Limits/Session Limits Detail"
  },
  {
    "id": "session-limits-provenance",
    "label": "Session Limits Provenance",
    "sourcePath": "packages/app/session-limits/components/session-limits-provenance.tsx",
    "section": "App Core",
    "pathSegments": [
      "Session Limits"
    ],
    "storyId": "session-limits-provenance",
    "storyTitle": "App Core/Session Limits/Session Limits Provenance"
  },
  {
    "id": "session-linked-chips-cell",
    "label": "SessionLinkedChipsCell",
    "sourcePath": "packages/app/agents/components/sessions/session-linked-chips-cell.tsx",
    "section": "App Core",
    "pathSegments": [
      "Sessions"
    ],
    "storyId": "session-linked-chips-cell",
    "storyTitle": "App Core/Sessions/SessionLinkedChipsCell"
  },
  {
    "id": "sessions-toolbar",
    "label": "SessionsToolbar",
    "sourcePath": "packages/app/agents/components/sessions/sessions-toolbar.tsx",
    "section": "App Core",
    "pathSegments": [
      "Sessions"
    ],
    "storyId": "sessions-toolbar",
    "storyTitle": "App Core/Sessions/SessionsToolbar"
  },
  {
    "id": "org-policy-toggle-card",
    "label": "Org Policy Toggle Card",
    "sourcePath": "packages/app/settings/components/org-policy-toggle-card.tsx",
    "section": "App Core",
    "pathSegments": [
      "Settings"
    ],
    "storyId": "org-policy-toggle-card",
    "storyTitle": "App Core/Settings/Org Policy Toggle Card"
  },
  {
    "id": "session-frustration-card",
    "label": "Session Frustration Card",
    "sourcePath": "packages/app/settings/components/session-frustration-card.tsx",
    "section": "App Core",
    "pathSegments": [
      "Settings"
    ],
    "storyId": "session-frustration-card",
    "storyTitle": "App Core/Settings/Session Frustration Card"
  },
  {
    "id": "comment-avatar",
    "label": "Comment Avatar",
    "sourcePath": "packages/app/shared/components/comment-avatar.tsx",
    "section": "App Core",
    "pathSegments": [
      "Shared"
    ],
    "storyId": "comment-avatar",
    "storyTitle": "App Core/Shared/Comment Avatar"
  },
  {
    "id": "feature-flag-pending",
    "label": "Feature Flag Pending",
    "sourcePath": "packages/app/shared/components/feature-flag-pending.tsx",
    "section": "App Core",
    "pathSegments": [
      "Shared"
    ],
    "storyId": "feature-flag-pending",
    "storyTitle": "App Core/Shared/Feature Flag Pending"
  },
  {
    "id": "read-source-badge",
    "label": "Read Source Badge",
    "sourcePath": "packages/app/shared/components/read-source-badge.tsx",
    "section": "App Core",
    "pathSegments": [
      "Shared"
    ],
    "storyId": "read-source-badge",
    "storyTitle": "App Core/Shared/Read Source Badge"
  },
  {
    "id": "status-badge",
    "label": "Status Badges",
    "sourcePath": "packages/app/shared/components/status-badge.tsx",
    "section": "App Core",
    "pathSegments": [
      "Shared"
    ],
    "storyId": "status-badge",
    "storyTitle": "App Core/Shared/Status Badges"
  },
  {
    "id": "summary-card-row",
    "label": "Summary Card Row",
    "sourcePath": "packages/app/shared/components/summary-card-row.tsx",
    "section": "App Core",
    "pathSegments": [
      "Shared"
    ],
    "storyId": "summary-card-row",
    "storyTitle": "App Core/Shared/Summary Card Row"
  },
  {
    "id": "tag-chip",
    "label": "Tag Chip",
    "sourcePath": "packages/app/tags/components/tag-chip.tsx",
    "section": "App Core",
    "pathSegments": [
      "Tags"
    ],
    "storyId": "tag-chip",
    "storyTitle": "App Core/Tags/Tag Chip"
  },
  {
    "id": "tag-color-picker",
    "label": "Tag Color Picker",
    "sourcePath": "packages/app/tags/components/tag-color-picker.tsx",
    "section": "App Core",
    "pathSegments": [
      "Tags"
    ],
    "storyId": "tag-color-picker",
    "storyTitle": "App Core/Tags/Tag Color Picker"
  },
  {
    "id": "tag-picker",
    "label": "Tag Picker",
    "sourcePath": "packages/app/tags/components/tag-picker.tsx",
    "section": "App Core",
    "pathSegments": [
      "Tags"
    ],
    "storyId": "tag-picker",
    "storyTitle": "App Core/Tags/Tag Picker"
  }
] as const satisfies readonly StorybookCatalogEntry[];

export const storybookComponentCatalog = [
  ...designSystemComponentCatalog,
  ...appComponentCatalog,
  ...appCoreComponentCatalog,
] as const satisfies readonly StorybookCatalogEntry[];

export function hasStory(entry: StorybookCatalogEntry) {
  return Boolean(entry.storyId) && !entry.internal;
}
