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
    "id": "active-filters-bar",
    "label": "Active Filters Bar",
    "sourcePath": "packages/design-system/components/ui/active-filters-bar.tsx",
    "section": "Design System",
    "pathSegments": [
      "Primitives"
    ],
    "storyId": "active-filters-bar",
    "storyTitle": "Design System/Primitives/Active Filters Bar"
  },
  {
    "id": "alert",
    "label": "Alert",
    "sourcePath": "packages/design-system/components/ui/alert.tsx",
    "section": "Design System",
    "pathSegments": [
      "Primitives"
    ],
    "storyId": "alert",
    "storyTitle": "Design System/Primitives/Alert"
  },
  {
    "id": "alert-dialog",
    "label": "Alert Dialog",
    "sourcePath": "packages/design-system/components/ui/alert-dialog.tsx",
    "section": "Design System",
    "pathSegments": [
      "Primitives"
    ],
    "storyId": "alert-dialog",
    "storyTitle": "Design System/Primitives/Alert Dialog"
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
    "id": "category-bar-chart",
    "label": "Category Bar Chart",
    "sourcePath": "packages/design-system/components/ui/category-bar-chart.tsx",
    "section": "Design System",
    "pathSegments": [
      "Primitives"
    ],
    "storyId": "category-bar-chart",
    "storyTitle": "Design System/Primitives/Category Bar Chart"
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
    "id": "code-block",
    "label": "Code Block",
    "sourcePath": "packages/design-system/components/ui/primitives/code-block.tsx",
    "section": "Design System",
    "pathSegments": [
      "Primitives"
    ],
    "storyId": "code-block",
    "storyTitle": "Design System/Primitives/Code Block"
  },
  {
    "id": "collapsible",
    "label": "Collapsible",
    "sourcePath": "packages/design-system/components/ui/collapsible.tsx",
    "section": "Design System",
    "pathSegments": [
      "Primitives"
    ],
    "storyId": "collapsible",
    "storyTitle": "Design System/Primitives/Collapsible"
  },
  {
    "id": "collapsible-section",
    "label": "Collapsible Section",
    "sourcePath": "packages/design-system/components/ui/collapsible-section.tsx",
    "section": "Design System",
    "pathSegments": [
      "Primitives"
    ],
    "storyId": "collapsible-section",
    "storyTitle": "Design System/Primitives/Collapsible Section"
  },
  {
    "id": "command",
    "label": "Command",
    "sourcePath": "packages/design-system/components/ui/command.tsx",
    "section": "Design System",
    "pathSegments": [
      "Primitives"
    ],
    "storyId": "command",
    "storyTitle": "Design System/Primitives/Command"
  },
  {
    "id": "conversation-message",
    "label": "Conversation Message",
    "sourcePath": "packages/design-system/components/ui/conversation-message.tsx",
    "section": "Design System",
    "pathSegments": [
      "Primitives"
    ],
    "storyId": "conversation-message",
    "storyTitle": "Design System/Primitives/Conversation Message"
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
    "id": "date-picker-popover",
    "label": "Date Picker Popover",
    "sourcePath": "packages/design-system/components/ui/date-picker-popover.tsx",
    "section": "Design System",
    "pathSegments": [
      "Primitives"
    ],
    "storyId": "date-picker-popover",
    "storyTitle": "Design System/Primitives/Date Picker Popover"
  },
  {
    "id": "dialog",
    "label": "Dialog",
    "sourcePath": "packages/design-system/components/ui/dialog.tsx",
    "section": "Design System",
    "pathSegments": [
      "Primitives"
    ],
    "storyId": "dialog",
    "storyTitle": "Design System/Primitives/Dialog"
  },
  {
    "id": "drawer",
    "label": "Drawer",
    "sourcePath": "packages/design-system/components/ui/drawer.tsx",
    "section": "Design System",
    "pathSegments": [
      "Primitives"
    ],
    "storyId": "drawer",
    "storyTitle": "Design System/Primitives/Drawer"
  },
  {
    "id": "dropdown-menu",
    "label": "Dropdown Menu",
    "sourcePath": "packages/design-system/components/ui/dropdown-menu.tsx",
    "section": "Design System",
    "pathSegments": [
      "Primitives"
    ],
    "storyId": "dropdown-menu",
    "storyTitle": "Design System/Primitives/Dropdown Menu"
  },
  {
    "id": "empty-state",
    "label": "Empty State",
    "sourcePath": "packages/design-system/components/ui/empty-state.tsx",
    "section": "Design System",
    "pathSegments": [
      "Primitives"
    ],
    "storyId": "empty-state",
    "storyTitle": "Design System/Primitives/Empty State"
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
    "id": "file-list",
    "label": "File List",
    "sourcePath": "packages/design-system/components/ui/primitives/file-list.tsx",
    "section": "Design System",
    "pathSegments": [
      "Primitives"
    ],
    "storyId": "file-list",
    "storyTitle": "Design System/Primitives/File List"
  },
  {
    "id": "filter-chip",
    "label": "Filter Chip",
    "sourcePath": "packages/design-system/components/ui/filter-chip.tsx",
    "section": "Design System",
    "pathSegments": [
      "Primitives"
    ],
    "storyId": "filter-chip",
    "storyTitle": "Design System/Primitives/Filter Chip"
  },
  {
    "id": "filter-popover",
    "label": "Filter Popover",
    "sourcePath": "packages/design-system/components/ui/filter-popover.tsx",
    "section": "Design System",
    "pathSegments": [
      "Primitives"
    ],
    "storyId": "filter-popover",
    "storyTitle": "Design System/Primitives/Filter Popover"
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
    "id": "group-section-header",
    "label": "Group Section Header",
    "sourcePath": "packages/design-system/components/ui/group-section-header.tsx",
    "section": "Design System",
    "pathSegments": [
      "Primitives"
    ],
    "storyId": "group-section-header",
    "storyTitle": "Design System/Primitives/Group Section Header"
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
    "id": "key-value-grid",
    "label": "Key Value Grid",
    "sourcePath": "packages/design-system/components/ui/primitives/key-value-grid.tsx",
    "section": "Design System",
    "pathSegments": [
      "Primitives"
    ],
    "storyId": "key-value-grid",
    "storyTitle": "Design System/Primitives/Key Value Grid"
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
    "id": "markdown-content",
    "label": "Markdown Content",
    "sourcePath": "packages/design-system/components/ui/primitives/markdown-content.tsx",
    "section": "Design System",
    "pathSegments": [
      "Primitives"
    ],
    "storyId": "markdown-content",
    "storyTitle": "Design System/Primitives/Markdown Content"
  },
  {
    "id": "match-list",
    "label": "Match List",
    "sourcePath": "packages/design-system/components/ui/primitives/match-list.tsx",
    "section": "Design System",
    "pathSegments": [
      "Primitives"
    ],
    "storyId": "match-list",
    "storyTitle": "Design System/Primitives/Match List"
  },
  {
    "id": "metadata-panel",
    "label": "Metadata Panel",
    "sourcePath": "packages/design-system/components/ui/metadata-panel.tsx",
    "section": "Design System",
    "pathSegments": [
      "Primitives"
    ],
    "storyId": "metadata-panel",
    "storyTitle": "Design System/Primitives/Metadata Panel"
  },
  {
    "id": "metric-card",
    "label": "Metric Card",
    "sourcePath": "packages/design-system/components/ui/primitives/metric-card.tsx",
    "section": "Design System",
    "pathSegments": [
      "Primitives"
    ],
    "storyId": "metric-card",
    "storyTitle": "Design System/Primitives/Metric Card"
  },
  {
    "id": "popover",
    "label": "Popover",
    "sourcePath": "packages/design-system/components/ui/popover.tsx",
    "section": "Design System",
    "pathSegments": [
      "Primitives"
    ],
    "storyId": "popover",
    "storyTitle": "Design System/Primitives/Popover"
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
    "id": "sheet",
    "label": "Sheet",
    "sourcePath": "packages/design-system/components/ui/sheet.tsx",
    "section": "Design System",
    "pathSegments": [
      "Primitives"
    ],
    "storyId": "sheet",
    "storyTitle": "Design System/Primitives/Sheet"
  },
  {
    "id": "sidebar-count-badge",
    "label": "Sidebar Count Badge",
    "sourcePath": "packages/design-system/components/ui/sidebar-count-badge.tsx",
    "section": "Design System",
    "pathSegments": [
      "Primitives"
    ],
    "storyId": "sidebar-count-badge",
    "storyTitle": "Design System/Primitives/Sidebar Count Badge"
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
    "id": "sonner",
    "label": "Sonner",
    "sourcePath": "packages/design-system/components/ui/sonner.tsx",
    "section": "Design System",
    "pathSegments": [
      "Primitives"
    ],
    "storyId": "sonner",
    "storyTitle": "Design System/Primitives/Sonner"
  },
  {
    "id": "sortable-column-header",
    "label": "Sortable Column Header",
    "sourcePath": "packages/design-system/components/ui/sortable-column-header.tsx",
    "section": "Design System",
    "pathSegments": [
      "Primitives"
    ],
    "storyId": "sortable-column-header",
    "storyTitle": "Design System/Primitives/Sortable Column Header"
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
    "id": "status-badge",
    "label": "Status Badge",
    "sourcePath": "packages/design-system/components/ui/primitives/status-badge.tsx",
    "section": "Design System",
    "pathSegments": [
      "Primitives"
    ],
    "storyId": "status-badge",
    "storyTitle": "Design System/Primitives/Status Badge"
  },
  {
    "id": "status-icon-primitives",
    "label": "Status Icon Primitives",
    "sourcePath": "packages/design-system/components/ui/status-icon-primitives.tsx",
    "section": "Design System",
    "pathSegments": [
      "Primitives"
    ],
    "storyId": "status-icon-primitives",
    "storyTitle": "Design System/Primitives/Status Icon Primitives"
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
    "id": "table-grid-header",
    "label": "Table Grid Header",
    "sourcePath": "packages/design-system/components/ui/table-grid-header.tsx",
    "section": "Design System",
    "pathSegments": [
      "Primitives"
    ],
    "storyId": "table-grid-header",
    "storyTitle": "Design System/Primitives/Table Grid Header"
  },
  {
    "id": "table-view-menu",
    "label": "Table View Menu",
    "sourcePath": "packages/design-system/components/ui/table-view-menu.tsx",
    "section": "Design System",
    "pathSegments": [
      "Primitives"
    ],
    "storyId": "table-view-menu",
    "storyTitle": "Design System/Primitives/Table View Menu"
  },
  {
    "id": "terminal-block",
    "label": "Terminal Block",
    "sourcePath": "packages/design-system/components/ui/primitives/terminal-block.tsx",
    "section": "Design System",
    "pathSegments": [
      "Primitives"
    ],
    "storyId": "terminal-block",
    "storyTitle": "Design System/Primitives/Terminal Block"
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
    "id": "time-series-area-chart",
    "label": "Time Series Area Chart",
    "sourcePath": "packages/design-system/components/ui/time-series-area-chart.tsx",
    "section": "Design System",
    "pathSegments": [
      "Primitives"
    ],
    "storyId": "time-series-area-chart",
    "storyTitle": "Design System/Primitives/Time Series Area Chart"
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
    "id": "tooltip",
    "label": "Tooltip",
    "sourcePath": "packages/design-system/components/ui/tooltip.tsx",
    "section": "Design System",
    "pathSegments": [
      "Primitives"
    ],
    "storyId": "tooltip",
    "storyTitle": "Design System/Primitives/Tooltip"
  },
  {
    "id": "underline-tabs",
    "label": "Underline Tabs",
    "sourcePath": "packages/design-system/components/ui/primitives/underline-tabs.tsx",
    "section": "Design System",
    "pathSegments": [
      "Primitives"
    ],
    "storyId": "underline-tabs",
    "storyTitle": "Design System/Primitives/Underline Tabs"
  },
  {
    "id": "unified-diff",
    "label": "Unified Diff",
    "sourcePath": "packages/design-system/components/ui/primitives/unified-diff.tsx",
    "section": "Design System",
    "pathSegments": [
      "Primitives"
    ],
    "storyId": "unified-diff",
    "storyTitle": "Design System/Primitives/Unified Diff"
  },
  {
    "id": "user-select-popover",
    "label": "User Select Popover",
    "sourcePath": "packages/design-system/components/ui/user-select-popover.tsx",
    "section": "Design System",
    "pathSegments": [
      "Primitives"
    ],
    "storyId": "user-select-popover",
    "storyTitle": "Design System/Primitives/User Select Popover"
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
    "id": "workflow-stat-tile",
    "label": "Workflow Stat Tile",
    "sourcePath": "packages/design-system/components/ui/primitives/workflow-stat-tile.tsx",
    "section": "Design System",
    "pathSegments": [
      "Data Display",
      "Data Visualization"
    ],
    "storyId": "workflow-stat-tile",
    "storyTitle": "Design System/Data Display/Data Visualization/Workflow Stat Tile"
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
      "Primitives"
    ],
    "storyId": "backend-mismatch-modal",
    "storyTitle": "Design System/Primitives/Backend Mismatch Modal"
  },
  {
    "id": "confirmation-dialog",
    "label": "Confirmation Dialog",
    "sourcePath": "packages/app/shared/components/confirmation-dialog.tsx",
    "section": "Design System",
    "pathSegments": [
      "Primitives"
    ],
    "storyId": "confirmation-dialog",
    "storyTitle": "Design System/Primitives/Confirmation Dialog"
  },
  {
    "id": "delete-confirmation-dialog",
    "label": "Delete Confirmation Dialog",
    "sourcePath": "packages/app/shared/components/delete-confirmation-dialog.tsx",
    "section": "Design System",
    "pathSegments": [
      "Primitives"
    ],
    "storyId": "delete-confirmation-dialog",
    "storyTitle": "Design System/Primitives/Delete Confirmation Dialog"
  },
  {
    "id": "friendly-error-alert",
    "label": "Friendly Error Alert",
    "sourcePath": "packages/app/shared/components/friendly-error-alert.tsx",
    "section": "Design System",
    "pathSegments": [
      "Primitives"
    ],
    "storyId": "friendly-error-alert",
    "storyTitle": "Design System/Primitives/Friendly Error Alert"
  },
  {
    "id": "page-loading-spinner",
    "label": "Page Loading Spinner",
    "sourcePath": "packages/app/shared/components/page-loading-spinner.tsx",
    "section": "Design System",
    "pathSegments": [
      "Primitives"
    ],
    "storyId": "page-loading-spinner",
    "storyTitle": "Design System/Primitives/Page Loading Spinner"
  }
] as const satisfies readonly StorybookCatalogEntry[];

export const appCoreComponentCatalog =
  [
  {
    "id": "active-runs-panel",
    "label": "Active Runs Panel",
    "sourcePath": "packages/app/agents/components/sessions/active-runs-panel.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents"
    ],
    "storyId": "active-runs-panel",
    "storyTitle": "App Core/Agents/Active Runs Panel"
  },
  {
    "id": "agent-card",
    "label": "Agent Card",
    "sourcePath": "packages/app/agents/components/agent-card.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents"
    ],
    "storyId": "agent-card",
    "storyTitle": "App Core/Agents/Agent Card"
  },
  {
    "id": "agent-collaboration-network",
    "label": "Agent Collaboration Network",
    "sourcePath": "packages/app/agents/components/agent-collaboration-network.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents"
    ],
    "storyId": "agent-collaboration-network",
    "storyTitle": "App Core/Agents/Agent Collaboration Network"
  },
  {
    "id": "orchestration-dag",
    "label": "Agent Orchestration Graph",
    "sourcePath": "packages/app/agents/components/orchestration-dag.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents"
    ],
    "storyId": "orchestration-dag",
    "storyTitle": "App Core/Agents/Agent Orchestration Graph"
  },
  {
    "id": "agent-pipeline-graph",
    "label": "Agent Pipeline Graph",
    "sourcePath": "packages/app/agents/components/agent-pipeline-graph.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents"
    ],
    "storyId": "agent-pipeline-graph",
    "storyTitle": "App Core/Agents/Agent Pipeline Graph"
  },
  {
    "id": "cli-tools-panel",
    "label": "Cli Tools Panel",
    "sourcePath": "packages/app/agents/components/cli-tools-panel.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents"
    ],
    "storyId": "cli-tools-panel",
    "storyTitle": "App Core/Agents/Cli Tools Panel"
  },
  {
    "id": "compaction-impact",
    "label": "Compaction Impact",
    "sourcePath": "packages/app/agents/components/compaction-impact.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents"
    ],
    "storyId": "compaction-impact",
    "storyTitle": "App Core/Agents/Compaction Impact"
  },
  {
    "id": "event-group-row",
    "label": "Event Group Row",
    "sourcePath": "packages/app/agents/components/events/event-group-row.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents"
    ],
    "storyId": "event-group-row",
    "storyTitle": "App Core/Agents/Event Group Row"
  },
  {
    "id": "model-usage-table",
    "label": "Model Usage Table",
    "sourcePath": "packages/app/agents/components/model-usage-table.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents"
    ],
    "storyId": "model-usage-table",
    "storyTitle": "App Core/Agents/Model Usage Table"
  },
  {
    "id": "agent-session-activity-feed",
    "label": "Session Activity Feed",
    "sourcePath": "packages/app/agents/components/activity/agent-session-activity-feed.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents"
    ],
    "storyId": "agent-session-activity-feed",
    "storyTitle": "App Core/Agents/Session Activity Feed"
  },
  {
    "id": "session-card",
    "label": "Session Card",
    "sourcePath": "packages/app/agents/components/sessions/session-card.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents"
    ],
    "storyId": "session-card",
    "storyTitle": "App Core/Agents/Session Card"
  },
  {
    "id": "agent-session-detail-view",
    "label": "Session Detail",
    "sourcePath": "packages/app/agents/components/detail/agent-session-detail-view.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents"
    ],
    "storyId": "agent-session-detail-view",
    "storyTitle": "App Core/Agents/Session Detail"
  },
  {
    "id": "session-detail-panels",
    "label": "Session Detail Panels",
    "sourcePath": "packages/app/agents/components/detail/session-detail-panels.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents"
    ],
    "storyId": "session-detail-panels",
    "storyTitle": "App Core/Agents/Session Detail Panels"
  },
  {
    "id": "session-status-badges",
    "label": "Session Status Badges",
    "sourcePath": "packages/app/agents/components/session-status-badges.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents"
    ],
    "storyId": "session-status-badges",
    "storyTitle": "App Core/Agents/Session Status Badges"
  },
  {
    "id": "sessions-controls",
    "label": "Sessions Controls",
    "sourcePath": "packages/app/agents/components/sessions/sessions-controls.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents"
    ],
    "storyId": "sessions-controls",
    "storyTitle": "App Core/Agents/Sessions Controls"
  },
  {
    "id": "sessions-table",
    "label": "Sessions Table",
    "sourcePath": "packages/app/agents/components/sessions/sessions-table.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents"
    ],
    "storyId": "sessions-table",
    "storyTitle": "App Core/Agents/Sessions Table"
  },
  {
    "id": "synced-sessions-table",
    "label": "Synced Sessions Table",
    "sourcePath": "packages/app/agents/components/sessions/synced-sessions-table.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents"
    ],
    "storyId": "synced-sessions-table",
    "storyTitle": "App Core/Agents/Synced Sessions Table"
  },
  {
    "id": "agent-telemetry-analytics",
    "label": "Telemetry Analytics",
    "sourcePath": "packages/app/agents/components/analytics/agent-telemetry-analytics.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents"
    ],
    "storyId": "agent-telemetry-analytics",
    "storyTitle": "App Core/Agents/Telemetry Analytics"
  },
  {
    "id": "thinking-block",
    "label": "Thinking Block",
    "sourcePath": "packages/app/agents/components/thinking-block.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents"
    ],
    "storyId": "thinking-block",
    "storyTitle": "App Core/Agents/Thinking Block"
  },
  {
    "id": "tool-call-block",
    "label": "Tool Call Block",
    "sourcePath": "packages/app/agents/components/tools/tool-call-block.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents"
    ],
    "storyId": "tool-call-block",
    "storyTitle": "App Core/Agents/Tool Call Block"
  },
  {
    "id": "tool-data-view",
    "label": "Tool Data View",
    "sourcePath": "packages/app/agents/components/tools/tool-data-view.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents"
    ],
    "storyId": "tool-data-view",
    "storyTitle": "App Core/Agents/Tool Data View"
  },
  {
    "id": "tool-result-block",
    "label": "Tool Result Block",
    "sourcePath": "packages/app/agents/components/tools/tool-result-block.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents"
    ],
    "storyId": "tool-result-block",
    "storyTitle": "App Core/Agents/Tool Result Block"
  },
  {
    "id": "user-usage-table",
    "label": "User Usage Table",
    "sourcePath": "packages/app/agents/components/user-usage-table.tsx",
    "section": "App Core",
    "pathSegments": [
      "Agents"
    ],
    "storyId": "user-usage-table",
    "storyTitle": "App Core/Agents/User Usage Table"
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
    "id": "feature-status-icon",
    "label": "Feature Status Icon",
    "sourcePath": "packages/app/documents/components/feature-status-icon.tsx",
    "section": "App Core",
    "pathSegments": [
      "Documents"
    ],
    "storyId": "feature-status-icon",
    "storyTitle": "App Core/Documents/Feature Status Icon"
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
