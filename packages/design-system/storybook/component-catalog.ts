export const canonicalStorybookRoots = ["Catalog","Foundations","Primitives","Composites","Surfaces"] as const;

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
    "id": "button",
    "label": "Button",
    "sourcePath": "packages/design-system/components/ui/button.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Actions"
    ],
    "storyId": "button",
    "storyTitle": "Primitives/Actions/Button"
  },
  {
    "id": "toggle",
    "label": "Toggle",
    "sourcePath": "packages/design-system/components/ui/toggle.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Actions"
    ],
    "storyId": "toggle",
    "storyTitle": "Primitives/Actions/Toggle"
  },
  {
    "id": "analytics-range-toggle",
    "label": "Analytics Range Toggle",
    "sourcePath": "packages/design-system/components/ui/analytics-range-toggle.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Inputs"
    ],
    "storyId": "analytics-range-toggle",
    "storyTitle": "Primitives/Inputs/Analytics Range Toggle"
  },
  {
    "id": "checkbox",
    "label": "Checkbox",
    "sourcePath": "packages/design-system/components/ui/checkbox.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Inputs"
    ],
    "storyId": "checkbox",
    "storyTitle": "Primitives/Inputs/Checkbox"
  },
  {
    "id": "filter-range-submenu",
    "label": "Filter Range Submenu",
    "sourcePath": "packages/design-system/components/ui/filter-range-submenu.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Inputs"
    ],
    "storyStatus": "catalog-only",
    "internal": true,
    "note": "Submenu inside the table filter menu.",
    "storyTitle": "Primitives/Inputs/Filter Range Submenu"
  },
  {
    "id": "input",
    "label": "Input",
    "sourcePath": "packages/design-system/components/ui/input.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Inputs"
    ],
    "storyId": "input",
    "storyTitle": "Primitives/Inputs/Input"
  },
  {
    "id": "label",
    "label": "Label",
    "sourcePath": "packages/design-system/components/ui/label.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Inputs"
    ],
    "storyId": "label",
    "storyTitle": "Primitives/Inputs/Label"
  },
  {
    "id": "radio-group",
    "label": "Radio Group",
    "sourcePath": "packages/design-system/components/ui/radio-group.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Inputs"
    ],
    "storyId": "radio-group",
    "storyTitle": "Primitives/Inputs/Radio Group"
  },
  {
    "id": "select",
    "label": "Select",
    "sourcePath": "packages/design-system/components/ui/select.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Inputs"
    ],
    "storyId": "select",
    "storyTitle": "Primitives/Inputs/Select"
  },
  {
    "id": "star-rating",
    "label": "Star Rating",
    "sourcePath": "packages/design-system/components/ui/star-rating.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Inputs"
    ],
    "storyId": "star-rating",
    "storyTitle": "Primitives/Inputs/Star Rating"
  },
  {
    "id": "switch",
    "label": "Switch",
    "sourcePath": "packages/design-system/components/ui/switch.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Inputs"
    ],
    "storyId": "switch",
    "storyTitle": "Primitives/Inputs/Switch"
  },
  {
    "id": "table-page-size-select",
    "label": "Table Page Size Select",
    "sourcePath": "packages/design-system/components/ui/table-page-size-select.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Inputs"
    ],
    "storyId": "table-page-size-select",
    "storyTitle": "Primitives/Inputs/Table Page Size Select"
  },
  {
    "id": "textarea",
    "label": "Textarea",
    "sourcePath": "packages/design-system/components/ui/textarea.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Inputs"
    ],
    "storyId": "textarea",
    "storyTitle": "Primitives/Inputs/Textarea"
  },
  {
    "id": "avatar",
    "label": "Avatar",
    "sourcePath": "packages/design-system/components/ui/avatar.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "avatar",
    "storyTitle": "Primitives/Data Display/Avatar"
  },
  {
    "id": "badge",
    "label": "Badge",
    "sourcePath": "packages/design-system/components/ui/badge.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "badge",
    "storyTitle": "Primitives/Data Display/Badge"
  },
  {
    "id": "chip",
    "label": "Chip",
    "sourcePath": "packages/design-system/components/ui/chip.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "chip",
    "storyTitle": "Primitives/Data Display/Chip"
  },
  {
    "id": "data-table",
    "label": "Data Table",
    "sourcePath": "packages/design-system/components/ui/data-table.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "data-table",
    "storyTitle": "Primitives/Data Display/Data Table"
  },
  {
    "id": "file-list",
    "label": "File List",
    "sourcePath": "packages/design-system/components/ui/primitives/file-list.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "file-list",
    "storyTitle": "Primitives/Data Display/File List"
  },
  {
    "id": "grid-table",
    "label": "Grid Table",
    "sourcePath": "packages/design-system/components/ui/grid-table.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "grid-table",
    "storyTitle": "Primitives/Data Display/Grid Table"
  },
  {
    "id": "grid-table-card",
    "label": "Grid Table Card",
    "sourcePath": "packages/design-system/components/ui/grid-table-card.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Data Display"
    ],
    "storyStatus": "catalog-only",
    "internal": true,
    "note": "Card row rendered by GridTable in compact mode.",
    "storyTitle": "Primitives/Data Display/Grid Table Card"
  },
  {
    "id": "key-value-grid",
    "label": "Key Value Grid",
    "sourcePath": "packages/design-system/components/ui/primitives/key-value-grid.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "key-value-grid",
    "storyTitle": "Primitives/Data Display/Key Value Grid"
  },
  {
    "id": "match-list",
    "label": "Match List",
    "sourcePath": "packages/design-system/components/ui/primitives/match-list.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "match-list",
    "storyTitle": "Primitives/Data Display/Match List"
  },
  {
    "id": "priority-badge",
    "label": "Priority Badge",
    "sourcePath": "packages/design-system/components/ui/priority-badge.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "priority-badge",
    "storyTitle": "Primitives/Data Display/Priority Badge"
  },
  {
    "id": "priority-icon",
    "label": "Priority Icon",
    "sourcePath": "packages/design-system/components/ui/priority-icon.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "priority-icon",
    "storyTitle": "Primitives/Data Display/Priority Icon"
  },
  {
    "id": "sidebar-count-badge",
    "label": "Sidebar Count Badge",
    "sourcePath": "packages/design-system/components/ui/sidebar-count-badge.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "sidebar-count-badge",
    "storyTitle": "Primitives/Data Display/Sidebar Count Badge"
  },
  {
    "id": "table",
    "label": "Table",
    "sourcePath": "packages/design-system/components/ui/table.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "table",
    "storyTitle": "Primitives/Data Display/Table"
  },
  {
    "id": "table-grid-header",
    "label": "Table Grid Header",
    "sourcePath": "packages/design-system/components/ui/table-grid-header.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "table-grid-header",
    "storyTitle": "Primitives/Data Display/Table Grid Header"
  },
  {
    "id": "tone-label",
    "label": "Tone Label",
    "sourcePath": "packages/design-system/components/ui/tone-label.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "tone-label",
    "storyTitle": "Primitives/Data Display/Tone Label"
  },
  {
    "id": "workflow-stat-tile",
    "label": "Workflow Stat Tile",
    "sourcePath": "packages/design-system/components/ui/primitives/workflow-stat-tile.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Data Display"
    ],
    "storyStatus": "catalog-only",
    "storyTitle": "Primitives/Data Display/Workflow Stat Tile"
  },
  {
    "id": "activity-heatmap",
    "label": "Activity Heatmap",
    "sourcePath": "packages/design-system/components/ui/primitives/activity-heatmap.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Charts"
    ],
    "storyId": "activity-heatmap",
    "storyTitle": "Primitives/Charts/Activity Heatmap"
  },
  {
    "id": "category-bar-chart",
    "label": "Category Bar Chart",
    "sourcePath": "packages/design-system/components/ui/category-bar-chart.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Charts"
    ],
    "storyId": "category-bar-chart",
    "storyTitle": "Primitives/Charts/Category Bar Chart"
  },
  {
    "id": "chart",
    "label": "Chart",
    "sourcePath": "packages/design-system/components/ui/chart.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Charts"
    ],
    "storyId": "chart",
    "storyTitle": "Primitives/Charts/Chart"
  },
  {
    "id": "donut-chart",
    "label": "Donut Chart",
    "sourcePath": "packages/design-system/components/ui/donut-chart.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Charts"
    ],
    "storyId": "donut-chart",
    "storyTitle": "Primitives/Charts/Donut Chart"
  },
  {
    "id": "donut-slice-textures",
    "label": "Donut Slice Textures",
    "sourcePath": "packages/design-system/components/ui/donut-slice-textures.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Charts"
    ],
    "storyStatus": "catalog-only",
    "storyTitle": "Primitives/Charts/Donut Slice Textures"
  },
  {
    "id": "graph",
    "label": "Graph",
    "sourcePath": "packages/design-system/components/ui/primitives/graph.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Charts"
    ],
    "storyId": "graph",
    "storyTitle": "Primitives/Charts/Graph"
  },
  {
    "id": "line-chart",
    "label": "Line Chart",
    "sourcePath": "packages/design-system/components/ui/primitives/line-chart.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Charts"
    ],
    "storyId": "line-chart",
    "storyTitle": "Primitives/Charts/Line Chart"
  },
  {
    "id": "sankey-graph",
    "label": "Sankey Graph",
    "sourcePath": "packages/design-system/components/ui/primitives/sankey-graph.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Charts"
    ],
    "storyId": "sankey-graph",
    "storyTitle": "Primitives/Charts/Sankey Graph"
  },
  {
    "id": "segmented-bar",
    "label": "Segmented Bar",
    "sourcePath": "packages/design-system/components/ui/primitives/segmented-bar.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Charts"
    ],
    "storyId": "segmented-bar",
    "storyTitle": "Primitives/Charts/Segmented Bar"
  },
  {
    "id": "sparkline",
    "label": "Sparkline",
    "sourcePath": "packages/design-system/components/ui/primitives/sparkline.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Charts"
    ],
    "storyId": "sparkline",
    "storyTitle": "Primitives/Charts/Sparkline"
  },
  {
    "id": "time-series-area-chart",
    "label": "Time Series Area Chart",
    "sourcePath": "packages/design-system/components/ui/time-series-area-chart.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Charts"
    ],
    "storyId": "time-series-area-chart",
    "storyTitle": "Primitives/Charts/Time Series Area Chart"
  },
  {
    "id": "brand-icons",
    "label": "Brand Icons",
    "sourcePath": "packages/design-system/components/ui/brand-icons.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Content"
    ],
    "storyId": "brand-icons",
    "storyTitle": "Primitives/Content/Brand Icons"
  },
  {
    "id": "code-block",
    "label": "Code Block",
    "sourcePath": "packages/design-system/components/ui/primitives/code-block.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Content"
    ],
    "storyId": "code-block",
    "storyTitle": "Primitives/Content/Code Block"
  },
  {
    "id": "collapsed-comment-row",
    "label": "Collapsed Comment Row",
    "sourcePath": "packages/design-system/components/ui/collapsed-comment-row.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Content"
    ],
    "storyId": "collapsed-comment-row",
    "storyTitle": "Primitives/Content/Collapsed Comment Row"
  },
  {
    "id": "comment-thread",
    "label": "Comment Thread",
    "sourcePath": "packages/design-system/components/ui/comment-thread.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Content"
    ],
    "storyId": "comment-thread",
    "storyTitle": "Primitives/Content/Comment Thread"
  },
  {
    "id": "conversation-message",
    "label": "Conversation Message",
    "sourcePath": "packages/design-system/components/ui/conversation-message.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Content"
    ],
    "storyId": "conversation-message",
    "storyTitle": "Primitives/Content/Conversation Message"
  },
  {
    "id": "conversation-transcript",
    "label": "Conversation Transcript",
    "sourcePath": "packages/design-system/components/ui/conversation-transcript.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Content"
    ],
    "storyId": "conversation-transcript",
    "storyTitle": "Primitives/Content/Conversation Transcript"
  },
  {
    "id": "markdown-content",
    "label": "Markdown Content",
    "sourcePath": "packages/design-system/components/ui/primitives/markdown-content.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Content"
    ],
    "storyId": "markdown-content",
    "storyTitle": "Primitives/Content/Markdown Content"
  },
  {
    "id": "terminal-block",
    "label": "Terminal Block",
    "sourcePath": "packages/design-system/components/ui/primitives/terminal-block.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Content"
    ],
    "storyId": "terminal-block",
    "storyTitle": "Primitives/Content/Terminal Block"
  },
  {
    "id": "unified-diff",
    "label": "Unified Diff",
    "sourcePath": "packages/design-system/components/ui/primitives/unified-diff.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Content"
    ],
    "storyId": "unified-diff",
    "storyTitle": "Primitives/Content/Unified Diff"
  },
  {
    "id": "card",
    "label": "Card",
    "sourcePath": "packages/design-system/components/ui/card.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Layout"
    ],
    "storyId": "card",
    "storyTitle": "Primitives/Layout/Card"
  },
  {
    "id": "collapsible",
    "label": "Collapsible",
    "sourcePath": "packages/design-system/components/ui/collapsible.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Layout"
    ],
    "storyId": "collapsible",
    "storyTitle": "Primitives/Layout/Collapsible"
  },
  {
    "id": "collapsible-section",
    "label": "Collapsible Section",
    "sourcePath": "packages/design-system/components/ui/collapsible-section.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Layout"
    ],
    "storyId": "collapsible-section",
    "storyTitle": "Primitives/Layout/Collapsible Section"
  },
  {
    "id": "feed-rail",
    "label": "Feed Rail",
    "sourcePath": "packages/design-system/components/ui/feed-rail.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Layout"
    ],
    "storyId": "feed-rail",
    "storyTitle": "Primitives/Layout/Feed Rail"
  },
  {
    "id": "group-section-header",
    "label": "Group Section Header",
    "sourcePath": "packages/design-system/components/ui/group-section-header.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Layout"
    ],
    "storyId": "group-section-header",
    "storyTitle": "Primitives/Layout/Group Section Header"
  },
  {
    "id": "inline-edit-editor-shell",
    "label": "Inline Edit Editor Shell",
    "sourcePath": "packages/design-system/components/ui/inline-edit-editor-shell.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Layout"
    ],
    "storyId": "inline-edit-editor-shell",
    "storyTitle": "Primitives/Layout/Inline Edit Editor Shell"
  },
  {
    "id": "resizable",
    "label": "Resizable Panel Group",
    "sourcePath": "packages/design-system/components/ui/resizable.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Layout"
    ],
    "storyId": "resizable",
    "storyTitle": "Primitives/Layout/Resizable Panel Group"
  },
  {
    "id": "scroll-area",
    "label": "Scroll Area",
    "sourcePath": "packages/design-system/components/ui/scroll-area.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Layout"
    ],
    "storyId": "scroll-area",
    "storyTitle": "Primitives/Layout/Scroll Area"
  },
  {
    "id": "section-header",
    "label": "Section Header",
    "sourcePath": "packages/design-system/components/ui/section-header.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Layout"
    ],
    "storyId": "section-header",
    "storyTitle": "Primitives/Layout/Section Header"
  },
  {
    "id": "separator",
    "label": "Separator",
    "sourcePath": "packages/design-system/components/ui/separator.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Layout"
    ],
    "storyId": "separator",
    "storyTitle": "Primitives/Layout/Separator"
  },
  {
    "id": "sidebar-collapsible-section",
    "label": "Sidebar Collapsible Section",
    "sourcePath": "packages/design-system/components/ui/sidebar-collapsible-section.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Layout"
    ],
    "storyId": "sidebar-collapsible-section",
    "storyTitle": "Primitives/Layout/Sidebar Collapsible Section"
  },
  {
    "id": "table-grid-header-handles",
    "label": "Table Grid Header Handles",
    "sourcePath": "packages/design-system/components/ui/table-grid-header-handles.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Layout"
    ],
    "storyId": "table-grid-header-handles",
    "storyTitle": "Primitives/Layout/Table Grid Header Handles"
  },
  {
    "id": "breadcrumb",
    "label": "Breadcrumb",
    "sourcePath": "packages/design-system/components/ui/breadcrumb.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Navigation"
    ],
    "storyId": "breadcrumb",
    "storyTitle": "Primitives/Navigation/Breadcrumb"
  },
  {
    "id": "mode-toggle",
    "label": "Mode Toggle",
    "sourcePath": "packages/design-system/components/ui/mode-toggle.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Navigation"
    ],
    "storyId": "mode-toggle",
    "storyTitle": "Primitives/Navigation/Mode Toggle"
  },
  {
    "id": "table-saved-views-switcher",
    "label": "Table Saved Views Switcher",
    "sourcePath": "packages/design-system/components/ui/table-saved-views-switcher.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Navigation"
    ],
    "storyId": "table-saved-views-switcher",
    "storyTitle": "Primitives/Navigation/Table Saved Views Switcher"
  },
  {
    "id": "tabs",
    "label": "Tabs",
    "sourcePath": "packages/design-system/components/ui/tabs.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Navigation"
    ],
    "storyId": "tabs",
    "storyTitle": "Primitives/Navigation/Tabs"
  },
  {
    "id": "theme-submenu",
    "label": "Theme Submenu",
    "sourcePath": "packages/design-system/components/ui/theme-submenu.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Navigation"
    ],
    "storyId": "theme-submenu",
    "storyTitle": "Primitives/Navigation/Theme Submenu"
  },
  {
    "id": "dialog",
    "label": "Dialog",
    "sourcePath": "packages/design-system/components/ui/dialog.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Overlays"
    ],
    "storyId": "dialog",
    "storyTitle": "Primitives/Overlays/Dialog"
  },
  {
    "id": "drawer",
    "label": "Drawer",
    "sourcePath": "packages/design-system/components/ui/drawer.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Overlays"
    ],
    "storyId": "drawer",
    "storyTitle": "Primitives/Overlays/Drawer"
  },
  {
    "id": "dropdown-menu",
    "label": "Dropdown Menu",
    "sourcePath": "packages/design-system/components/ui/dropdown-menu.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Overlays"
    ],
    "storyId": "dropdown-menu",
    "storyTitle": "Primitives/Overlays/Dropdown Menu"
  },
  {
    "id": "popover",
    "label": "Popover",
    "sourcePath": "packages/design-system/components/ui/popover.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Overlays"
    ],
    "storyId": "popover",
    "storyTitle": "Primitives/Overlays/Popover"
  },
  {
    "id": "sheet",
    "label": "Sheet",
    "sourcePath": "packages/design-system/components/ui/sheet.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Overlays"
    ],
    "storyId": "sheet",
    "storyTitle": "Primitives/Overlays/Sheet"
  },
  {
    "id": "sonner",
    "label": "Sonner",
    "sourcePath": "packages/design-system/components/ui/sonner.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Overlays"
    ],
    "storyId": "sonner",
    "storyTitle": "Primitives/Overlays/Sonner"
  },
  {
    "id": "table-grid-column-menu",
    "label": "Table Grid Column Menu",
    "sourcePath": "packages/design-system/components/ui/table-grid-column-menu.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Overlays"
    ],
    "storyId": "table-grid-column-menu",
    "storyTitle": "Primitives/Overlays/Table Grid Column Menu"
  },
  {
    "id": "table-view-menu",
    "label": "Table View Menu",
    "sourcePath": "packages/design-system/components/ui/table-view-menu.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Overlays"
    ],
    "storyId": "table-view-menu",
    "storyTitle": "Primitives/Overlays/Table View Menu"
  },
  {
    "id": "tooltip",
    "label": "Tooltip",
    "sourcePath": "packages/design-system/components/ui/tooltip.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Overlays"
    ],
    "storyId": "tooltip",
    "storyTitle": "Primitives/Overlays/Tooltip"
  },
  {
    "id": "alert",
    "label": "Alert",
    "sourcePath": "packages/design-system/components/ui/alert.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Feedback & Status"
    ],
    "storyId": "alert",
    "storyTitle": "Primitives/Feedback & Status/Alert"
  },
  {
    "id": "progress",
    "label": "Progress",
    "sourcePath": "packages/design-system/components/ui/progress.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Feedback & Status"
    ],
    "storyId": "progress",
    "storyTitle": "Primitives/Feedback & Status/Progress"
  },
  {
    "id": "skeleton",
    "label": "Skeleton",
    "sourcePath": "packages/design-system/components/ui/skeleton.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Feedback & Status"
    ],
    "storyId": "skeleton",
    "storyTitle": "Primitives/Feedback & Status/Skeleton"
  },
  {
    "id": "status-icon",
    "label": "Status Icon",
    "sourcePath": "packages/design-system/components/ui/status-icon.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Feedback & Status"
    ],
    "storyId": "status-icon",
    "storyTitle": "Primitives/Feedback & Status/Status Icon"
  },
  {
    "id": "status-icon-primitives",
    "label": "Status Icon Primitives",
    "sourcePath": "packages/design-system/components/ui/status-icon-primitives.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Feedback & Status"
    ],
    "storyId": "status-icon-primitives",
    "storyTitle": "Primitives/Feedback & Status/Status Icon Primitives"
  },
  {
    "id": "status-percentage-icon",
    "label": "Status Percentage Icon",
    "sourcePath": "packages/design-system/components/ui/status-percentage-icon.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Feedback & Status"
    ],
    "storyId": "status-percentage-icon",
    "storyTitle": "Primitives/Feedback & Status/Status Percentage Icon"
  },
  {
    "id": "comment-thread-action-footer",
    "label": "Comment Thread Action Footer",
    "sourcePath": "packages/design-system/components/ui/comment-thread-action-footer.tsx",
    "section": "Composites",
    "pathSegments": [
      "Actions"
    ],
    "storyId": "comment-thread-action-footer",
    "storyTitle": "Composites/Actions/Comment Thread Action Footer"
  },
  {
    "id": "copy-button",
    "label": "Copy Button",
    "sourcePath": "packages/design-system/components/ui/primitives/copy-button.tsx",
    "section": "Composites",
    "pathSegments": [
      "Actions"
    ],
    "storyId": "copy-button",
    "storyTitle": "Composites/Actions/Copy Button"
  },
  {
    "id": "favorite-button",
    "label": "Favorite Button",
    "sourcePath": "packages/design-system/components/ui/favorite-button.tsx",
    "section": "Composites",
    "pathSegments": [
      "Actions"
    ],
    "storyId": "favorite-button",
    "storyTitle": "Composites/Actions/Favorite Button"
  },
  {
    "id": "calendar",
    "label": "Calendar",
    "sourcePath": "packages/design-system/components/ui/calendar.tsx",
    "section": "Composites",
    "pathSegments": [
      "Inputs"
    ],
    "storyId": "calendar",
    "storyTitle": "Composites/Inputs/Calendar"
  },
  {
    "id": "comment-composer",
    "label": "Comment Composer",
    "sourcePath": "packages/design-system/components/ui/comment-composer.tsx",
    "section": "Composites",
    "pathSegments": [
      "Inputs"
    ],
    "storyId": "comment-composer",
    "storyTitle": "Composites/Inputs/Comment Composer"
  },
  {
    "id": "date-picker-popover",
    "label": "Date Picker Popover",
    "sourcePath": "packages/design-system/components/ui/date-picker-popover.tsx",
    "section": "Composites",
    "pathSegments": [
      "Inputs"
    ],
    "storyId": "date-picker-popover",
    "storyTitle": "Composites/Inputs/Date Picker Popover"
  },
  {
    "id": "form",
    "label": "Form",
    "sourcePath": "packages/design-system/components/ui/form.tsx",
    "section": "Composites",
    "pathSegments": [
      "Inputs"
    ],
    "storyId": "form",
    "storyTitle": "Composites/Inputs/Form"
  },
  {
    "id": "status-metadata-section",
    "label": "Status Metadata Section",
    "sourcePath": "packages/design-system/components/ui/status-metadata-section.tsx",
    "section": "Composites",
    "pathSegments": [
      "Inputs"
    ],
    "storyId": "status-metadata-section",
    "storyTitle": "Composites/Inputs/Status Metadata Section"
  },
  {
    "id": "toggle-group",
    "label": "Toggle Group",
    "sourcePath": "packages/design-system/components/ui/toggle-group.tsx",
    "section": "Composites",
    "pathSegments": [
      "Inputs"
    ],
    "storyId": "toggle-group",
    "storyTitle": "Composites/Inputs/Toggle Group"
  },
  {
    "id": "active-filters-bar",
    "label": "Active Filters Bar",
    "sourcePath": "packages/design-system/components/ui/active-filters-bar.tsx",
    "section": "Composites",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "active-filters-bar",
    "storyTitle": "Composites/Data Display/Active Filters Bar"
  },
  {
    "id": "filter-chip",
    "label": "Filter Chip",
    "sourcePath": "packages/design-system/components/ui/filter-chip.tsx",
    "section": "Composites",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "filter-chip",
    "storyTitle": "Composites/Data Display/Filter Chip"
  },
  {
    "id": "filter-popover",
    "label": "Filter Popover",
    "sourcePath": "packages/design-system/components/ui/filter-popover.tsx",
    "section": "Composites",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "filter-popover",
    "storyTitle": "Composites/Data Display/Filter Popover"
  },
  {
    "id": "metadata-panel",
    "label": "Metadata Panel",
    "sourcePath": "packages/design-system/components/ui/metadata-panel.tsx",
    "section": "Composites",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "metadata-panel",
    "storyTitle": "Composites/Data Display/Metadata Panel"
  },
  {
    "id": "metric-card",
    "label": "Metric Card",
    "sourcePath": "packages/design-system/components/ui/primitives/metric-card.tsx",
    "section": "Composites",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "metric-card",
    "storyTitle": "Composites/Data Display/Metric Card"
  },
  {
    "id": "sortable-column-header",
    "label": "Sortable Column Header",
    "sourcePath": "packages/design-system/components/ui/sortable-column-header.tsx",
    "section": "Composites",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "sortable-column-header",
    "storyTitle": "Composites/Data Display/Sortable Column Header"
  },
  {
    "id": "table-filter-menu",
    "label": "Table Filter Menu",
    "sourcePath": "packages/design-system/components/ui/table-filter-menu.tsx",
    "section": "Composites",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "table-filter-menu",
    "storyTitle": "Composites/Data Display/Table Filter Menu"
  },
  {
    "id": "table-pagination",
    "label": "Table Pagination",
    "sourcePath": "packages/design-system/components/ui/table-pagination.tsx",
    "section": "Composites",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "table-pagination",
    "storyTitle": "Composites/Data Display/Table Pagination"
  },
  {
    "id": "table-pagination-footer",
    "label": "Table Pagination Footer",
    "sourcePath": "packages/design-system/components/ui/table-pagination-footer.tsx",
    "section": "Composites",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "table-pagination-footer",
    "storyTitle": "Composites/Data Display/Table Pagination Footer"
  },
  {
    "id": "table-placeholder-actions",
    "label": "Table Placeholder Actions",
    "sourcePath": "packages/design-system/components/ui/table-placeholder-actions.tsx",
    "section": "Composites",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "table-placeholder-actions",
    "storyTitle": "Composites/Data Display/Table Placeholder Actions"
  },
  {
    "id": "ranked-bar",
    "label": "Ranked Bar",
    "sourcePath": "packages/design-system/components/ui/primitives/ranked-bar.tsx",
    "section": "Composites",
    "pathSegments": [
      "Charts"
    ],
    "storyId": "ranked-bar",
    "storyTitle": "Composites/Charts/Ranked Bar"
  },
  {
    "id": "kanban-board",
    "label": "Kanban Board",
    "sourcePath": "packages/design-system/components/ui/layout/kanban-board.tsx",
    "section": "Composites",
    "pathSegments": [
      "Layout"
    ],
    "storyId": "kanban-board",
    "storyTitle": "Composites/Layout/Kanban Board"
  },
  {
    "id": "section",
    "label": "Section",
    "sourcePath": "packages/design-system/components/ui/layout/section.tsx",
    "section": "Composites",
    "pathSegments": [
      "Layout"
    ],
    "storyId": "section",
    "storyTitle": "Composites/Layout/Section"
  },
  {
    "id": "sidebar",
    "label": "Sidebar",
    "sourcePath": "packages/design-system/components/ui/sidebar.tsx",
    "section": "Composites",
    "pathSegments": [
      "Navigation"
    ],
    "storyId": "sidebar",
    "storyTitle": "Composites/Navigation/Sidebar"
  },
  {
    "id": "underline-tabs",
    "label": "Underline Tabs",
    "sourcePath": "packages/design-system/components/ui/primitives/underline-tabs.tsx",
    "section": "Composites",
    "pathSegments": [
      "Navigation"
    ],
    "storyId": "underline-tabs",
    "storyTitle": "Composites/Navigation/Underline Tabs"
  },
  {
    "id": "alert-dialog",
    "label": "Alert Dialog",
    "sourcePath": "packages/design-system/components/ui/alert-dialog.tsx",
    "section": "Composites",
    "pathSegments": [
      "Overlays"
    ],
    "storyId": "alert-dialog",
    "storyTitle": "Composites/Overlays/Alert Dialog"
  },
  {
    "id": "command",
    "label": "Command",
    "sourcePath": "packages/design-system/components/ui/command.tsx",
    "section": "Composites",
    "pathSegments": [
      "Overlays"
    ],
    "storyId": "command",
    "storyTitle": "Composites/Overlays/Command"
  },
  {
    "id": "comment-action-menu",
    "label": "Comment Action Menu",
    "sourcePath": "packages/design-system/components/ui/comment-action-menu.tsx",
    "section": "Composites",
    "pathSegments": [
      "Overlays"
    ],
    "storyId": "comment-action-menu",
    "storyTitle": "Composites/Overlays/Comment Action Menu"
  },
  {
    "id": "user-select-popover",
    "label": "User Select Popover",
    "sourcePath": "packages/design-system/components/ui/user-select-popover.tsx",
    "section": "Composites",
    "pathSegments": [
      "Overlays"
    ],
    "storyId": "user-select-popover",
    "storyTitle": "Composites/Overlays/User Select Popover"
  },
  {
    "id": "empty-state",
    "label": "Empty State",
    "sourcePath": "packages/design-system/components/ui/empty-state.tsx",
    "section": "Composites",
    "pathSegments": [
      "Feedback & Status"
    ],
    "storyId": "empty-state",
    "storyTitle": "Composites/Feedback & Status/Empty State"
  },
  {
    "id": "info-hint",
    "label": "Info Hint",
    "sourcePath": "packages/design-system/components/ui/primitives/info-hint.tsx",
    "section": "Composites",
    "pathSegments": [
      "Feedback & Status"
    ],
    "storyId": "info-hint",
    "storyTitle": "Composites/Feedback & Status/Info Hint"
  },
  {
    "id": "status-badge",
    "label": "Status Badge",
    "sourcePath": "packages/design-system/components/ui/primitives/status-badge.tsx",
    "section": "Composites",
    "pathSegments": [
      "Feedback & Status"
    ],
    "storyId": "status-badge",
    "storyTitle": "Composites/Feedback & Status/Status Badge"
  }
] as const satisfies readonly StorybookCatalogEntry[];

export const appComponentCatalog =
  [
  {
    "id": "friendly-error-alert",
    "label": "Friendly Error Alert",
    "sourcePath": "packages/app/shared/components/friendly-error-alert.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Feedback & Status"
    ],
    "storyId": "friendly-error-alert",
    "storyTitle": "Primitives/Feedback & Status/Friendly Error Alert"
  },
  {
    "id": "page-loading-spinner",
    "label": "Page Loading Spinner",
    "sourcePath": "packages/app/shared/components/page-loading-spinner.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Feedback & Status"
    ],
    "storyId": "page-loading-spinner",
    "storyTitle": "Primitives/Feedback & Status/Page Loading Spinner"
  },
  {
    "id": "backend-mismatch-modal",
    "label": "Backend Mismatch Modal",
    "sourcePath": "packages/app/compute/components/backend-mismatch-modal.tsx",
    "section": "Composites",
    "pathSegments": [
      "Overlays"
    ],
    "storyId": "backend-mismatch-modal",
    "storyTitle": "Composites/Overlays/Backend Mismatch Modal"
  },
  {
    "id": "confirmation-dialog",
    "label": "Confirmation Dialog",
    "sourcePath": "packages/app/shared/components/confirmation-dialog.tsx",
    "section": "Composites",
    "pathSegments": [
      "Overlays"
    ],
    "storyId": "confirmation-dialog",
    "storyTitle": "Composites/Overlays/Confirmation Dialog"
  },
  {
    "id": "delete-confirmation-dialog",
    "label": "Delete Confirmation Dialog",
    "sourcePath": "packages/app/shared/components/delete-confirmation-dialog.tsx",
    "section": "Composites",
    "pathSegments": [
      "Overlays"
    ],
    "storyId": "delete-confirmation-dialog",
    "storyTitle": "Composites/Overlays/Delete Confirmation Dialog"
  }
] as const satisfies readonly StorybookCatalogEntry[];

export const appCoreComponentCatalog =
  [
  {
    "id": "tag-color-picker",
    "label": "Tag Color Picker",
    "sourcePath": "packages/app/tags/components/tag-color-picker.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Inputs"
    ],
    "storyId": "tag-color-picker",
    "storyTitle": "Primitives/Inputs/Tag Color Picker"
  },
  {
    "id": "branch-cell-primitives",
    "label": "Branch Cell Primitives",
    "sourcePath": "packages/app/branches/components/branch-cell-primitives.stories.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "branch-cell-primitives",
    "storyTitle": "Primitives/Data Display/Branch Cell Primitives"
  },
  {
    "id": "branch-properties-panel",
    "label": "Branch Properties Panel",
    "sourcePath": "packages/app/branches/components/branch-properties-panel.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "branch-properties-panel",
    "storyTitle": "Primitives/Data Display/Branch Properties Panel"
  },
  {
    "id": "loc-per-dollar-cell",
    "label": "LOC Per Dollar Column Value",
    "sourcePath": "packages/app/agents/components/workspace/loc-per-dollar-cell.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "loc-per-dollar-cell",
    "storyTitle": "Primitives/Data Display/LOC Per Dollar Column Value"
  },
  {
    "id": "overview-metric",
    "label": "Overview Metric",
    "sourcePath": "packages/app/insights/components/overview/overview-metric.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "overview-metric",
    "storyTitle": "Primitives/Data Display/Overview Metric"
  },
  {
    "id": "session-flagged-properties",
    "label": "Session Flagged Properties",
    "sourcePath": "packages/app/agents/components/detail/session-flagged-properties.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "session-flagged-properties",
    "storyTitle": "Primitives/Data Display/Session Flagged Properties"
  },
  {
    "id": "session-loc-per-dollar-property",
    "label": "Session LOC Per Dollar Property",
    "sourcePath": "packages/app/agents/components/detail/session-loc-per-dollar-property.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "session-loc-per-dollar-property",
    "storyTitle": "Primitives/Data Display/Session LOC Per Dollar Property"
  },
  {
    "id": "session-output-diff",
    "label": "Session Output Diff",
    "sourcePath": "packages/app/agents/components/detail/session-output-diff.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "session-output-diff",
    "storyTitle": "Primitives/Data Display/Session Output Diff"
  },
  {
    "id": "session-provenance-chip",
    "label": "Session Provenance Chip",
    "sourcePath": "packages/app/agents/components/sessions/session-provenance-chip.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "session-provenance-chip",
    "storyTitle": "Primitives/Data Display/Session Provenance Chip"
  },
  {
    "id": "session-pull-requests-row",
    "label": "Session Pull Requests Row",
    "sourcePath": "packages/app/agents/components/detail/session-pull-requests-row.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "session-pull-requests-row",
    "storyTitle": "Primitives/Data Display/Session Pull Requests Row"
  },
  {
    "id": "session-trace-subagent",
    "label": "Session Trace Subagent",
    "sourcePath": "packages/app/agents/components/detail/session-trace-subagent.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "session-trace-subagent",
    "storyTitle": "Primitives/Data Display/Session Trace Subagent"
  },
  {
    "id": "trace-event-row",
    "label": "Trace Event Row",
    "sourcePath": "packages/app/agents/components/detail/trace-event-row.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "trace-event-row",
    "storyTitle": "Primitives/Data Display/Trace Event Row"
  },
  {
    "id": "trace-harness-tags",
    "label": "Trace Tag Chip",
    "sourcePath": "packages/app/agents/components/detail/trace-harness-tags.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "trace-harness-tags",
    "storyTitle": "Primitives/Data Display/Trace Tag Chip"
  },
  {
    "id": "agent-pipeline-graph",
    "label": "Agent Pipeline Graph",
    "sourcePath": "packages/app/agents/components/agent-pipeline-graph.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Charts"
    ],
    "storyId": "agent-pipeline-graph",
    "storyTitle": "Primitives/Charts/Agent Pipeline Graph"
  },
  {
    "id": "branch-cost-to-merge",
    "label": "Branch Cost to Merge",
    "sourcePath": "packages/app/branches/components/branch-cost-to-merge.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Charts"
    ],
    "storyId": "branch-cost-to-merge",
    "storyTitle": "Primitives/Charts/Branch Cost to Merge"
  },
  {
    "id": "branch-lead-time-waterfall",
    "label": "Branch Lead Time Waterfall",
    "sourcePath": "packages/app/branches/components/branch-lead-time-waterfall.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Charts"
    ],
    "storyId": "branch-lead-time-waterfall",
    "storyTitle": "Primitives/Charts/Branch Lead Time Waterfall"
  },
  {
    "id": "session-timeline-axis",
    "label": "Session Timeline Axis",
    "sourcePath": "packages/app/agents/components/detail/session-timeline-axis.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Charts"
    ],
    "storyId": "session-timeline-axis",
    "storyTitle": "Primitives/Charts/Session Timeline Axis"
  },
  {
    "id": "session-timeline-bars",
    "label": "Session Timeline Bars",
    "sourcePath": "packages/app/agents/components/detail/session-timeline-bars.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Charts"
    ],
    "storyId": "session-timeline-bars",
    "storyTitle": "Primitives/Charts/Session Timeline Bars"
  },
  {
    "id": "session-timeline-bar-labels",
    "label": "Session Timeline Cost Rail",
    "sourcePath": "packages/app/agents/components/detail/session-timeline-bar-labels.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Charts"
    ],
    "storyId": "session-timeline-bar-labels",
    "storyTitle": "Primitives/Charts/Session Timeline Cost Rail"
  },
  {
    "id": "session-timeline-dot-rail",
    "label": "Session Timeline Dot Rail",
    "sourcePath": "packages/app/agents/components/detail/session-timeline-dot-rail.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Charts"
    ],
    "storyId": "session-timeline-dot-rail",
    "storyTitle": "Primitives/Charts/Session Timeline Dot Rail"
  },
  {
    "id": "session-comments-rail",
    "label": "Session Comments Rail",
    "sourcePath": "packages/app/agents/components/detail/session-comments-rail.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Content"
    ],
    "storyId": "session-comments-rail",
    "storyTitle": "Primitives/Content/Session Comments Rail"
  },
  {
    "id": "session-group-icons",
    "label": "Session Group Icons",
    "sourcePath": "packages/app/agents/components/sessions/session-group-icons.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Content"
    ],
    "storyId": "session-group-icons",
    "storyTitle": "Primitives/Content/Session Group Icons"
  },
  {
    "id": "session-trace-tool-row-detail",
    "label": "Session Trace Tool Row Detail",
    "sourcePath": "packages/app/agents/components/detail/session-trace-tool-row-detail.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Content"
    ],
    "storyId": "session-trace-tool-row-detail",
    "storyTitle": "Primitives/Content/Session Trace Tool Row Detail"
  },
  {
    "id": "trace-message-body",
    "label": "Trace Message Body",
    "sourcePath": "packages/app/agents/components/detail/trace-message-body.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Content"
    ],
    "storyId": "trace-message-body",
    "storyTitle": "Primitives/Content/Trace Message Body"
  },
  {
    "id": "activity-bucket-tooltip",
    "label": "Activity Bucket Tooltip",
    "sourcePath": "packages/app/agents/components/detail/activity-bucket-tooltip.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Overlays"
    ],
    "storyId": "activity-bucket-tooltip",
    "storyTitle": "Primitives/Overlays/Activity Bucket Tooltip"
  },
  {
    "id": "session-timeline-strip-parts",
    "label": "Session Timeline Event Dot Tooltip",
    "sourcePath": "packages/app/agents/components/detail/session-timeline-strip-parts.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Overlays"
    ],
    "storyId": "session-timeline-strip-parts",
    "storyTitle": "Primitives/Overlays/Session Timeline Event Dot Tooltip"
  },
  {
    "id": "viewport-tooltip",
    "label": "Viewport Tooltip",
    "sourcePath": "packages/app/agents/components/detail/viewport-tooltip.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Overlays"
    ],
    "storyId": "viewport-tooltip",
    "storyTitle": "Primitives/Overlays/Viewport Tooltip"
  },
  {
    "id": "feature-flag-pending",
    "label": "Feature Flag Pending",
    "sourcePath": "packages/app/shared/components/feature-flag-pending.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Feedback & Status"
    ],
    "storyId": "feature-flag-pending",
    "storyTitle": "Primitives/Feedback & Status/Feature Flag Pending"
  },
  {
    "id": "loop-status-badge",
    "label": "Loop Status Badge",
    "sourcePath": "packages/app/loops/components/loop-status-badge.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Feedback & Status"
    ],
    "storyId": "loop-status-badge",
    "storyTitle": "Primitives/Feedback & Status/Loop Status Badge"
  },
  {
    "id": "branch-provider-availability",
    "label": "Provider Availability",
    "sourcePath": "packages/app/branches/components/comments/branch-provider-availability.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Feedback & Status"
    ],
    "storyId": "branch-provider-availability",
    "storyTitle": "Primitives/Feedback & Status/Provider Availability"
  },
  {
    "id": "session-limits-detail",
    "label": "Session Limits Detail",
    "sourcePath": "packages/app/session-limits/components/session-limits-detail.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Feedback & Status"
    ],
    "storyId": "session-limits-detail",
    "storyTitle": "Primitives/Feedback & Status/Session Limits Detail"
  },
  {
    "id": "sessions-sign-in-indicator",
    "label": "Sessions Sign In Indicator",
    "sourcePath": "packages/app/agents/components/sessions/sessions-sign-in-indicator.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Feedback & Status"
    ],
    "storyId": "sessions-sign-in-indicator",
    "storyTitle": "Primitives/Feedback & Status/Sessions Sign In Indicator"
  },
  {
    "id": "system-check-status-badge",
    "label": "System Check Status Badge",
    "sourcePath": "packages/app/compute/components/system-check-status-badge.tsx",
    "section": "Primitives",
    "pathSegments": [
      "Feedback & Status"
    ],
    "storyId": "system-check-status-badge",
    "storyTitle": "Primitives/Feedback & Status/System Check Status Badge"
  },
  {
    "id": "unified-search-results",
    "label": "Unified Search Results",
    "sourcePath": "packages/app/search/components/unified-search-results.tsx",
    "section": "Composites",
    "pathSegments": [
      "Data Display"
    ],
    "storyId": "unified-search-results",
    "storyTitle": "Composites/Data Display/Unified Search Results"
  },
  {
    "id": "summary-card-row",
    "label": "Summary Card Row",
    "sourcePath": "packages/app/shared/components/summary-card-row.tsx",
    "section": "Composites",
    "pathSegments": [
      "Layout"
    ],
    "storyId": "summary-card-row",
    "storyTitle": "Composites/Layout/Summary Card Row"
  },
  {
    "id": "read-source-badge",
    "label": "Read Source Badge",
    "sourcePath": "packages/app/shared/components/read-source-badge.tsx",
    "section": "Composites",
    "pathSegments": [
      "Feedback & Status"
    ],
    "storyId": "read-source-badge",
    "storyTitle": "Composites/Feedback & Status/Read Source Badge"
  },
  {
    "id": "status-badge",
    "label": "Status Badges",
    "sourcePath": "packages/app/shared/components/status-badge.tsx",
    "section": "Composites",
    "pathSegments": [
      "Feedback & Status"
    ],
    "storyId": "status-badge",
    "storyTitle": "Composites/Feedback & Status/Status Badges"
  },
  {
    "id": "agent-card",
    "label": "Agent Card",
    "sourcePath": "packages/app/agents/components/agent-card.tsx",
    "section": "Composites",
    "pathSegments": [
      "Agents"
    ],
    "storyId": "agent-card",
    "storyTitle": "Composites/Agents/Agent Card"
  },
  {
    "id": "agent-collaboration-network",
    "label": "Agent Collaboration Network",
    "sourcePath": "packages/app/agents/components/agent-collaboration-network.tsx",
    "section": "Composites",
    "pathSegments": [
      "Agents"
    ],
    "storyId": "agent-collaboration-network",
    "storyTitle": "Composites/Agents/Agent Collaboration Network"
  },
  {
    "id": "orchestration-dag",
    "label": "Agent Orchestration Graph",
    "sourcePath": "packages/app/agents/components/orchestration-dag.tsx",
    "section": "Composites",
    "pathSegments": [
      "Agents"
    ],
    "storyId": "orchestration-dag",
    "storyTitle": "Composites/Agents/Agent Orchestration Graph"
  },
  {
    "id": "agents-table",
    "label": "Agents Table",
    "sourcePath": "packages/app/agents/components/workspace/agents-table.tsx",
    "section": "Composites",
    "pathSegments": [
      "Agents"
    ],
    "storyId": "agents-table",
    "storyTitle": "Composites/Agents/Agents Table"
  },
  {
    "id": "agents-type-tab-strip",
    "label": "Agents Type Tab Strip",
    "sourcePath": "packages/app/agents/components/workspace/agents-type-tab-strip.tsx",
    "section": "Composites",
    "pathSegments": [
      "Agents"
    ],
    "storyId": "agents-type-tab-strip",
    "storyTitle": "Composites/Agents/Agents Type Tab Strip"
  },
  {
    "id": "cli-tools-panel",
    "label": "Cli Tools Panel",
    "sourcePath": "packages/app/agents/components/cli-tools-panel.tsx",
    "section": "Composites",
    "pathSegments": [
      "Agents"
    ],
    "storyId": "cli-tools-panel",
    "storyTitle": "Composites/Agents/Cli Tools Panel"
  },
  {
    "id": "compaction-impact",
    "label": "Compaction Impact",
    "sourcePath": "packages/app/agents/components/compaction-impact.tsx",
    "section": "Composites",
    "pathSegments": [
      "Agents"
    ],
    "storyId": "compaction-impact",
    "storyTitle": "Composites/Agents/Compaction Impact"
  },
  {
    "id": "context-cards",
    "label": "Context Cards",
    "sourcePath": "packages/app/agents/components/analytics/context-cards.tsx",
    "section": "Composites",
    "pathSegments": [
      "Agents"
    ],
    "storyId": "context-cards",
    "storyTitle": "Composites/Agents/Context Cards"
  },
  {
    "id": "error-propagation-map",
    "label": "Error Propagation Map",
    "sourcePath": "packages/app/agents/components/detail/error-propagation-map.tsx",
    "section": "Composites",
    "pathSegments": [
      "Agents"
    ],
    "storyId": "error-propagation-map",
    "storyTitle": "Composites/Agents/Error Propagation Map"
  },
  {
    "id": "invocation-evidence-list",
    "label": "Invocation Evidence List",
    "sourcePath": "packages/app/agents/components/workspace/invocation-evidence-list.tsx",
    "section": "Composites",
    "pathSegments": [
      "Agents"
    ],
    "storyId": "invocation-evidence-list",
    "storyTitle": "Composites/Agents/Invocation Evidence List"
  },
  {
    "id": "model-usage-table",
    "label": "Model Usage Table",
    "sourcePath": "packages/app/agents/components/model-usage-table.tsx",
    "section": "Composites",
    "pathSegments": [
      "Agents"
    ],
    "storyId": "model-usage-table",
    "storyTitle": "Composites/Agents/Model Usage Table"
  },
  {
    "id": "agent-orchestration-graph",
    "label": "Session Detail Orchestration Graph",
    "sourcePath": "packages/app/agents/components/detail/agent-orchestration-graph.tsx",
    "section": "Composites",
    "pathSegments": [
      "Agents"
    ],
    "storyId": "agent-orchestration-graph",
    "storyTitle": "Composites/Agents/Session Detail Orchestration Graph"
  },
  {
    "id": "subagent-effectiveness-panel",
    "label": "Subagent Effectiveness Panel",
    "sourcePath": "packages/app/agents/components/detail/subagent-effectiveness-panel.tsx",
    "section": "Composites",
    "pathSegments": [
      "Agents"
    ],
    "storyId": "subagent-effectiveness-panel",
    "storyTitle": "Composites/Agents/Subagent Effectiveness Panel"
  },
  {
    "id": "token-trend-chart",
    "label": "Token Trend Chart",
    "sourcePath": "packages/app/agents/components/workspace/token-trend-chart.tsx",
    "section": "Composites",
    "pathSegments": [
      "Agents"
    ],
    "storyId": "token-trend-chart",
    "storyTitle": "Composites/Agents/Token Trend Chart"
  },
  {
    "id": "user-usage-table",
    "label": "User Usage Table",
    "sourcePath": "packages/app/agents/components/user-usage-table.tsx",
    "section": "Composites",
    "pathSegments": [
      "Agents"
    ],
    "storyId": "user-usage-table",
    "storyTitle": "Composites/Agents/User Usage Table"
  },
  {
    "id": "agent-session-detail-analytics-tabs",
    "label": "Agent Session Detail Analytics Tabs",
    "sourcePath": "packages/app/agents/components/detail/agent-session-detail-analytics-tabs.tsx",
    "section": "Composites",
    "pathSegments": [
      "Sessions",
      "Detail"
    ],
    "storyId": "agent-session-detail-analytics-tabs",
    "storyTitle": "Composites/Sessions/Detail/Agent Session Detail Analytics Tabs"
  },
  {
    "id": "agent-session-detail-states",
    "label": "Agent Session Detail States",
    "sourcePath": "packages/app/agents/components/detail/agent-session-detail-states.tsx",
    "section": "Composites",
    "pathSegments": [
      "Sessions",
      "Detail"
    ],
    "storyId": "agent-session-detail-states",
    "storyTitle": "Composites/Sessions/Detail/Agent Session Detail States"
  },
  {
    "id": "detail-sessions-tab",
    "label": "Detail Sessions Tab",
    "sourcePath": "packages/app/agents/components/workspace/detail-sessions-tab.tsx",
    "section": "Composites",
    "pathSegments": [
      "Sessions",
      "Detail"
    ],
    "storyId": "detail-sessions-tab",
    "storyTitle": "Composites/Sessions/Detail/Detail Sessions Tab"
  },
  {
    "id": "event-group-row",
    "label": "Event Group Row",
    "sourcePath": "packages/app/agents/components/events/event-group-row.tsx",
    "section": "Composites",
    "pathSegments": [
      "Sessions",
      "Detail"
    ],
    "storyId": "event-group-row",
    "storyTitle": "Composites/Sessions/Detail/Event Group Row"
  },
  {
    "id": "limit-bar",
    "label": "Limit Bar",
    "sourcePath": "packages/app/session-limits/components/limit-bar.tsx",
    "section": "Composites",
    "pathSegments": [
      "Sessions",
      "Detail"
    ],
    "storyId": "limit-bar",
    "storyTitle": "Composites/Sessions/Detail/Limit Bar"
  },
  {
    "id": "property-values",
    "label": "Property Value",
    "sourcePath": "packages/app/agents/components/detail/property-values.tsx",
    "section": "Composites",
    "pathSegments": [
      "Sessions",
      "Detail"
    ],
    "storyId": "property-values",
    "storyTitle": "Composites/Sessions/Detail/Property Value"
  },
  {
    "id": "agent-session-activity-feed",
    "label": "Session Activity Feed",
    "sourcePath": "packages/app/agents/components/activity/agent-session-activity-feed.tsx",
    "section": "Composites",
    "pathSegments": [
      "Sessions",
      "Detail"
    ],
    "storyId": "agent-session-activity-feed",
    "storyTitle": "Composites/Sessions/Detail/Session Activity Feed"
  },
  {
    "id": "session-detail-panels",
    "label": "Session Detail Panels",
    "sourcePath": "packages/app/agents/components/detail/session-detail-panels.tsx",
    "section": "Composites",
    "pathSegments": [
      "Sessions",
      "Detail"
    ],
    "storyId": "session-detail-panels",
    "storyTitle": "Composites/Sessions/Detail/Session Detail Panels"
  },
  {
    "id": "session-duration-property",
    "label": "Session Duration Property",
    "sourcePath": "packages/app/agents/components/detail/session-duration-property.tsx",
    "section": "Composites",
    "pathSegments": [
      "Sessions",
      "Detail"
    ],
    "storyId": "session-duration-property",
    "storyTitle": "Composites/Sessions/Detail/Session Duration Property"
  },
  {
    "id": "session-limits-provenance",
    "label": "Session Limits Provenance",
    "sourcePath": "packages/app/session-limits/components/session-limits-provenance.tsx",
    "section": "Composites",
    "pathSegments": [
      "Sessions",
      "Detail"
    ],
    "storyId": "session-limits-provenance",
    "storyTitle": "Composites/Sessions/Detail/Session Limits Provenance"
  },
  {
    "id": "session-linked-artifacts-row",
    "label": "Session Linked Artifacts Row",
    "sourcePath": "packages/app/agents/components/detail/session-linked-artifacts-row.tsx",
    "section": "Composites",
    "pathSegments": [
      "Sessions",
      "Detail"
    ],
    "storyId": "session-linked-artifacts-row",
    "storyTitle": "Composites/Sessions/Detail/Session Linked Artifacts Row"
  },
  {
    "id": "session-measured-properties",
    "label": "Session Measured Properties",
    "sourcePath": "packages/app/agents/components/detail/session-measured-properties.tsx",
    "section": "Composites",
    "pathSegments": [
      "Sessions",
      "Detail"
    ],
    "storyId": "session-measured-properties",
    "storyTitle": "Composites/Sessions/Detail/Session Measured Properties"
  },
  {
    "id": "session-properties-panel",
    "label": "Session Properties Panel",
    "sourcePath": "packages/app/agents/components/detail/session-properties-panel.tsx",
    "section": "Composites",
    "pathSegments": [
      "Sessions",
      "Detail"
    ],
    "storyId": "session-properties-panel",
    "storyTitle": "Composites/Sessions/Detail/Session Properties Panel"
  },
  {
    "id": "session-pull-request-pill",
    "label": "Session Pull Request Pill",
    "sourcePath": "packages/app/agents/components/detail/session-pull-request-pill.tsx",
    "section": "Composites",
    "pathSegments": [
      "Sessions",
      "Detail"
    ],
    "storyId": "session-pull-request-pill",
    "storyTitle": "Composites/Sessions/Detail/Session Pull Request Pill"
  },
  {
    "id": "active-runs-panel",
    "label": "Active Runs Panel",
    "sourcePath": "packages/app/agents/components/sessions/active-runs-panel.tsx",
    "section": "Composites",
    "pathSegments": [
      "Sessions",
      "Listing"
    ],
    "storyId": "active-runs-panel",
    "storyTitle": "Composites/Sessions/Listing/Active Runs Panel"
  },
  {
    "id": "agent-sessions-list",
    "label": "Agent Sessions List",
    "sourcePath": "packages/app/agents/components/sessions/agent-sessions-list.tsx",
    "section": "Composites",
    "pathSegments": [
      "Sessions",
      "Listing"
    ],
    "storyId": "agent-sessions-list",
    "storyTitle": "Composites/Sessions/Listing/Agent Sessions List"
  },
  {
    "id": "cloud-sync-state-badge",
    "label": "Cloud Sync State Badge",
    "sourcePath": "packages/app/agents/components/sessions/cloud-sync-state-badge.tsx",
    "section": "Composites",
    "pathSegments": [
      "Sessions",
      "Listing"
    ],
    "storyId": "cloud-sync-state-badge",
    "storyTitle": "Composites/Sessions/Listing/Cloud Sync State Badge"
  },
  {
    "id": "cost-metric-card",
    "label": "Cost Metric Card",
    "sourcePath": "packages/app/agents/components/sessions/cost-metric-card.tsx",
    "section": "Composites",
    "pathSegments": [
      "Sessions",
      "Listing"
    ],
    "storyId": "cost-metric-card",
    "storyTitle": "Composites/Sessions/Listing/Cost Metric Card"
  },
  {
    "id": "session-card",
    "label": "Session Card",
    "sourcePath": "packages/app/agents/components/sessions/session-card.tsx",
    "section": "Composites",
    "pathSegments": [
      "Sessions",
      "Listing"
    ],
    "storyId": "session-card",
    "storyTitle": "Composites/Sessions/Listing/Session Card"
  },
  {
    "id": "session-cell-chips",
    "label": "Session Cell Chips",
    "sourcePath": "packages/app/agents/components/sessions/session-cell-chips.tsx",
    "section": "Composites",
    "pathSegments": [
      "Sessions",
      "Listing"
    ],
    "storyId": "session-cell-chips",
    "storyTitle": "Composites/Sessions/Listing/Session Cell Chips"
  },
  {
    "id": "session-cost-cell",
    "label": "Session Cost Cell",
    "sourcePath": "packages/app/agents/components/sessions/session-cost-cell.tsx",
    "section": "Composites",
    "pathSegments": [
      "Sessions",
      "Listing"
    ],
    "storyId": "session-cost-cell",
    "storyTitle": "Composites/Sessions/Listing/Session Cost Cell"
  },
  {
    "id": "session-linked-chips-cell",
    "label": "Session Linked Chips Cell",
    "sourcePath": "packages/app/agents/components/sessions/session-linked-chips-cell.tsx",
    "section": "Composites",
    "pathSegments": [
      "Sessions",
      "Listing"
    ],
    "storyId": "session-linked-chips-cell",
    "storyTitle": "Composites/Sessions/Listing/Session Linked Chips Cell"
  },
  {
    "id": "session-status-badges",
    "label": "Session Status Badges",
    "sourcePath": "packages/app/agents/components/session-status-badges.tsx",
    "section": "Composites",
    "pathSegments": [
      "Sessions",
      "Listing"
    ],
    "storyId": "session-status-badges",
    "storyTitle": "Composites/Sessions/Listing/Session Status Badges"
  },
  {
    "id": "session-sync-status-badge",
    "label": "Session Sync Status Badge",
    "sourcePath": "packages/app/agents/components/sessions/session-sync-status-badge.tsx",
    "section": "Composites",
    "pathSegments": [
      "Sessions",
      "Listing"
    ],
    "storyId": "session-sync-status-badge",
    "storyTitle": "Composites/Sessions/Listing/Session Sync Status Badge"
  },
  {
    "id": "sessions-active-filters-bar",
    "label": "Sessions Active Filters Bar",
    "sourcePath": "packages/app/agents/components/sessions/sessions-active-filters-bar.tsx",
    "section": "Composites",
    "pathSegments": [
      "Sessions",
      "Listing"
    ],
    "storyId": "sessions-active-filters-bar",
    "storyTitle": "Composites/Sessions/Listing/Sessions Active Filters Bar"
  },
  {
    "id": "sessions-controls",
    "label": "Sessions Controls",
    "sourcePath": "packages/app/agents/components/sessions/sessions-controls.tsx",
    "section": "Composites",
    "pathSegments": [
      "Sessions",
      "Listing"
    ],
    "storyId": "sessions-controls",
    "storyTitle": "Composites/Sessions/Listing/Sessions Controls"
  },
  {
    "id": "sessions-empty-state",
    "label": "Sessions Empty State",
    "sourcePath": "packages/app/agents/components/sessions/sessions-empty-state.tsx",
    "section": "Composites",
    "pathSegments": [
      "Sessions",
      "Listing"
    ],
    "storyId": "sessions-empty-state",
    "storyTitle": "Composites/Sessions/Listing/Sessions Empty State"
  },
  {
    "id": "sessions-recovery-action",
    "label": "Sessions Recovery Action",
    "sourcePath": "packages/app/agents/components/sessions/sessions-recovery-action.tsx",
    "section": "Composites",
    "pathSegments": [
      "Sessions",
      "Listing"
    ],
    "storyId": "sessions-recovery-action",
    "storyTitle": "Composites/Sessions/Listing/Sessions Recovery Action"
  },
  {
    "id": "sessions-summary-cards",
    "label": "Sessions Summary Cards",
    "sourcePath": "packages/app/agents/components/sessions/sessions-summary-cards.tsx",
    "section": "Composites",
    "pathSegments": [
      "Sessions",
      "Listing"
    ],
    "storyId": "sessions-summary-cards",
    "storyTitle": "Composites/Sessions/Listing/Sessions Summary Cards"
  },
  {
    "id": "sessions-summary-cards-loading",
    "label": "Sessions Summary Cards Loading",
    "sourcePath": "packages/app/agents/components/sessions/sessions-summary-cards-loading.tsx",
    "section": "Composites",
    "pathSegments": [
      "Sessions",
      "Listing"
    ],
    "storyId": "sessions-summary-cards-loading",
    "storyTitle": "Composites/Sessions/Listing/Sessions Summary Cards Loading"
  },
  {
    "id": "sessions-summary-delta-slots",
    "label": "Sessions Summary Delta Slots",
    "sourcePath": "packages/app/agents/components/sessions/sessions-summary-delta-slots.tsx",
    "section": "Composites",
    "pathSegments": [
      "Sessions",
      "Listing"
    ],
    "storyId": "sessions-summary-delta-slots",
    "storyTitle": "Composites/Sessions/Listing/Sessions Summary Delta Slots"
  },
  {
    "id": "sessions-table",
    "label": "Sessions Table",
    "sourcePath": "packages/app/agents/components/sessions/sessions-table.tsx",
    "section": "Composites",
    "pathSegments": [
      "Sessions",
      "Listing"
    ],
    "storyId": "sessions-table",
    "storyTitle": "Composites/Sessions/Listing/Sessions Table"
  },
  {
    "id": "sessions-toolbar",
    "label": "Sessions Toolbar",
    "sourcePath": "packages/app/agents/components/sessions/sessions-toolbar.tsx",
    "section": "Composites",
    "pathSegments": [
      "Sessions",
      "Listing"
    ],
    "storyId": "sessions-toolbar",
    "storyTitle": "Composites/Sessions/Listing/Sessions Toolbar"
  },
  {
    "id": "synced-sessions-table",
    "label": "Synced Sessions Table",
    "sourcePath": "packages/app/agents/components/sessions/synced-sessions-table.tsx",
    "section": "Composites",
    "pathSegments": [
      "Sessions",
      "Listing"
    ],
    "storyId": "synced-sessions-table",
    "storyTitle": "Composites/Sessions/Listing/Synced Sessions Table"
  },
  {
    "id": "session-timeline-controls",
    "label": "Session Timeline Controls",
    "sourcePath": "packages/app/agents/components/detail/session-timeline-controls.tsx",
    "section": "Composites",
    "pathSegments": [
      "Sessions",
      "Trace"
    ],
    "storyId": "session-timeline-controls",
    "storyTitle": "Composites/Sessions/Trace/Session Timeline Controls"
  },
  {
    "id": "session-timeline-summary",
    "label": "Session Timeline Summary",
    "sourcePath": "packages/app/agents/components/detail/session-timeline-summary.tsx",
    "section": "Composites",
    "pathSegments": [
      "Sessions",
      "Trace"
    ],
    "storyId": "session-timeline-summary",
    "storyTitle": "Composites/Sessions/Trace/Session Timeline Summary"
  },
  {
    "id": "session-trace",
    "label": "Session Trace",
    "sourcePath": "packages/app/agents/components/detail/session-trace.tsx",
    "section": "Composites",
    "pathSegments": [
      "Sessions",
      "Trace"
    ],
    "storyId": "session-trace",
    "storyTitle": "Composites/Sessions/Trace/Session Trace"
  },
  {
    "id": "thinking-block",
    "label": "Thinking Block",
    "sourcePath": "packages/app/agents/components/thinking-block.tsx",
    "section": "Composites",
    "pathSegments": [
      "Sessions",
      "Trace"
    ],
    "storyId": "thinking-block",
    "storyTitle": "Composites/Sessions/Trace/Thinking Block"
  },
  {
    "id": "tool-call-block",
    "label": "Tool Call Block",
    "sourcePath": "packages/app/agents/components/tools/tool-call-block.tsx",
    "section": "Composites",
    "pathSegments": [
      "Sessions",
      "Trace"
    ],
    "storyId": "tool-call-block",
    "storyTitle": "Composites/Sessions/Trace/Tool Call Block"
  },
  {
    "id": "tool-data-view",
    "label": "Tool Data View",
    "sourcePath": "packages/app/agents/components/tools/tool-data-view.tsx",
    "section": "Composites",
    "pathSegments": [
      "Sessions",
      "Trace"
    ],
    "storyId": "tool-data-view",
    "storyTitle": "Composites/Sessions/Trace/Tool Data View"
  },
  {
    "id": "tool-execution-flow",
    "label": "Tool Execution Flow",
    "sourcePath": "packages/app/agents/components/detail/tool-execution-flow.tsx",
    "section": "Composites",
    "pathSegments": [
      "Sessions",
      "Trace"
    ],
    "storyId": "tool-execution-flow",
    "storyTitle": "Composites/Sessions/Trace/Tool Execution Flow"
  },
  {
    "id": "tool-result-block",
    "label": "Tool Result Block",
    "sourcePath": "packages/app/agents/components/tools/tool-result-block.tsx",
    "section": "Composites",
    "pathSegments": [
      "Sessions",
      "Trace"
    ],
    "storyId": "tool-result-block",
    "storyTitle": "Composites/Sessions/Trace/Tool Result Block"
  },
  {
    "id": "trace-comments-rail",
    "label": "Trace Comments Rail",
    "sourcePath": "packages/app/agents/components/detail/trace-comments-rail.tsx",
    "section": "Composites",
    "pathSegments": [
      "Sessions",
      "Trace"
    ],
    "storyId": "trace-comments-rail",
    "storyTitle": "Composites/Sessions/Trace/Trace Comments Rail"
  },
  {
    "id": "trace-markdown",
    "label": "Trace Markdown",
    "sourcePath": "packages/app/agents/components/detail/trace-markdown.tsx",
    "section": "Composites",
    "pathSegments": [
      "Sessions",
      "Trace"
    ],
    "storyId": "trace-markdown",
    "storyTitle": "Composites/Sessions/Trace/Trace Markdown"
  },
  {
    "id": "transcript-file-switcher",
    "label": "Transcript File Switcher",
    "sourcePath": "packages/app/agents/components/detail/transcript-file-switcher.tsx",
    "section": "Composites",
    "pathSegments": [
      "Sessions",
      "Trace"
    ],
    "storyId": "transcript-file-switcher",
    "storyTitle": "Composites/Sessions/Trace/Transcript File Switcher"
  },
  {
    "id": "transcript-force-archive-action",
    "label": "Transcript Force Archive Action",
    "sourcePath": "packages/app/agents/components/detail/transcript-force-archive-action.tsx",
    "section": "Composites",
    "pathSegments": [
      "Sessions",
      "Trace"
    ],
    "storyId": "transcript-force-archive-action",
    "storyTitle": "Composites/Sessions/Trace/Transcript Force Archive Action"
  },
  {
    "id": "branch-delivered-panel",
    "label": "Branch Delivered Panel",
    "sourcePath": "packages/app/branches/components/detail/branch-delivered-panel.tsx",
    "section": "Composites",
    "pathSegments": [
      "Branches"
    ],
    "storyId": "branch-delivered-panel",
    "storyTitle": "Composites/Branches/Branch Delivered Panel"
  },
  {
    "id": "branch-files-changed-panel",
    "label": "Branch Files Changed Panel",
    "sourcePath": "packages/app/branches/components/detail/branch-files-changed-panel.tsx",
    "section": "Composites",
    "pathSegments": [
      "Branches"
    ],
    "storyId": "branch-files-changed-panel",
    "storyTitle": "Composites/Branches/Branch Files Changed Panel"
  },
  {
    "id": "branch-headline-cards",
    "label": "Branch Headline Cards",
    "sourcePath": "packages/app/branches/components/branch-headline-cards.tsx",
    "section": "Composites",
    "pathSegments": [
      "Branches"
    ],
    "storyId": "branch-headline-cards",
    "storyTitle": "Composites/Branches/Branch Headline Cards"
  },
  {
    "id": "branch-pr-status-panel",
    "label": "Branch PR Status Panel",
    "sourcePath": "packages/app/branches/components/detail/branch-pr-status-panel.tsx",
    "section": "Composites",
    "pathSegments": [
      "Branches"
    ],
    "storyId": "branch-pr-status-panel",
    "storyTitle": "Composites/Branches/Branch PR Status Panel"
  },
  {
    "id": "branch-selected-pull-request-workspace",
    "label": "Branch Selected Pull Request Workspace",
    "sourcePath": "packages/app/branches/components/detail/branch-selected-pull-request-workspace.tsx",
    "section": "Composites",
    "pathSegments": [
      "Branches"
    ],
    "storyId": "branch-selected-pull-request-workspace",
    "storyTitle": "Composites/Branches/Branch Selected Pull Request Workspace"
  },
  {
    "id": "branch-sessions-timeline-tab",
    "label": "Branch Sessions Timeline Tab",
    "sourcePath": "packages/app/branches/components/detail/branch-sessions-timeline-tab.tsx",
    "section": "Composites",
    "pathSegments": [
      "Branches"
    ],
    "storyId": "branch-sessions-timeline-tab",
    "storyTitle": "Composites/Branches/Branch Sessions Timeline Tab"
  },
  {
    "id": "branches-list-body",
    "label": "Branches List Body",
    "sourcePath": "packages/app/branches/components/branches-list-body.tsx",
    "section": "Composites",
    "pathSegments": [
      "Branches"
    ],
    "storyId": "branches-list-body",
    "storyTitle": "Composites/Branches/Branches List Body"
  },
  {
    "id": "branches-summary-cards",
    "label": "Branches Summary Cards",
    "sourcePath": "packages/app/branches/components/branches-summary-cards.tsx",
    "section": "Composites",
    "pathSegments": [
      "Branches"
    ],
    "storyId": "branches-summary-cards",
    "storyTitle": "Composites/Branches/Branches Summary Cards"
  },
  {
    "id": "branches-table",
    "label": "Branches Table",
    "sourcePath": "packages/app/branches/components/branches-table.tsx",
    "section": "Composites",
    "pathSegments": [
      "Branches"
    ],
    "storyId": "branches-table",
    "storyTitle": "Composites/Branches/Branches Table"
  },
  {
    "id": "branches-toolbar",
    "label": "Branches Toolbar",
    "sourcePath": "packages/app/branches/components/branches-toolbar.tsx",
    "section": "Composites",
    "pathSegments": [
      "Branches"
    ],
    "storyId": "branches-toolbar",
    "storyTitle": "Composites/Branches/Branches Toolbar"
  },
  {
    "id": "comment-avatar",
    "label": "Comment Avatar",
    "sourcePath": "packages/app/shared/components/comment-avatar.tsx",
    "section": "Composites",
    "pathSegments": [
      "Branches"
    ],
    "storyId": "comment-avatar",
    "storyTitle": "Composites/Branches/Comment Avatar"
  },
  {
    "id": "branch-comment-card",
    "label": "Comment Card",
    "sourcePath": "packages/app/branches/components/comments/branch-comment-card.tsx",
    "section": "Composites",
    "pathSegments": [
      "Branches"
    ],
    "storyId": "branch-comment-card",
    "storyTitle": "Composites/Branches/Comment Card"
  },
  {
    "id": "branch-comments-rail",
    "label": "Comments Rail",
    "sourcePath": "packages/app/branches/components/comments/branch-comments-rail.tsx",
    "section": "Composites",
    "pathSegments": [
      "Branches"
    ],
    "storyId": "branch-comments-rail",
    "storyTitle": "Composites/Branches/Comments Rail"
  },
  {
    "id": "detail-branches-tab",
    "label": "Detail Branches Tab",
    "sourcePath": "packages/app/agents/components/workspace/detail-branches-tab.tsx",
    "section": "Composites",
    "pathSegments": [
      "Branches"
    ],
    "storyId": "detail-branches-tab",
    "storyTitle": "Composites/Branches/Detail Branches Tab"
  },
  {
    "id": "branch-event-dot-rail",
    "label": "Event Dot Rail",
    "sourcePath": "packages/app/branches/components/branch-event-dot-rail.tsx",
    "section": "Composites",
    "pathSegments": [
      "Branches"
    ],
    "storyId": "branch-event-dot-rail",
    "storyTitle": "Composites/Branches/Event Dot Rail"
  },
  {
    "id": "branch-merged-trace",
    "label": "Merged Trace",
    "sourcePath": "packages/app/branches/components/branch-merged-trace.tsx",
    "section": "Composites",
    "pathSegments": [
      "Branches"
    ],
    "storyId": "branch-merged-trace",
    "storyTitle": "Composites/Branches/Merged Trace"
  },
  {
    "id": "branch-pr-activity-timeline",
    "label": "PR Activity Timeline",
    "sourcePath": "packages/app/branches/components/branch-pr-activity-timeline.tsx",
    "section": "Composites",
    "pathSegments": [
      "Branches"
    ],
    "storyId": "branch-pr-activity-timeline",
    "storyTitle": "Composites/Branches/PR Activity Timeline"
  },
  {
    "id": "pr-comment-markdown",
    "label": "PR Description Markdown",
    "sourcePath": "packages/app/branches/components/pr-comment-markdown.tsx",
    "section": "Composites",
    "pathSegments": [
      "Branches"
    ],
    "storyId": "pr-comment-markdown",
    "storyTitle": "Composites/Branches/PR Description Markdown"
  },
  {
    "id": "branch-pr-session-swimlane",
    "label": "PR Session Swimlane",
    "sourcePath": "packages/app/branches/components/branch-pr-session-swimlane.tsx",
    "section": "Composites",
    "pathSegments": [
      "Branches"
    ],
    "storyId": "branch-pr-session-swimlane",
    "storyTitle": "Composites/Branches/PR Session Swimlane"
  },
  {
    "id": "branch-pull-request-selector",
    "label": "Pull Request Selector",
    "sourcePath": "packages/app/branches/components/branch-pull-request-selector.tsx",
    "section": "Composites",
    "pathSegments": [
      "Branches"
    ],
    "storyId": "branch-pull-request-selector",
    "storyTitle": "Composites/Branches/Pull Request Selector"
  },
  {
    "id": "branch-trace-actor-avatar",
    "label": "Trace Actor Avatar",
    "sourcePath": "packages/app/branches/components/branch-trace-actor-avatar.tsx",
    "section": "Composites",
    "pathSegments": [
      "Branches"
    ],
    "storyId": "branch-trace-actor-avatar",
    "storyTitle": "Composites/Branches/Trace Actor Avatar"
  },
  {
    "id": "activity-actor",
    "label": "Activity Actor",
    "sourcePath": "packages/app/documents/components/feed-sidebar/sources/activity-actor.tsx",
    "section": "Composites",
    "pathSegments": [
      "Documents"
    ],
    "storyId": "activity-actor",
    "storyTitle": "Composites/Documents/Activity Actor"
  },
  {
    "id": "activity-card-view",
    "label": "Activity Card View",
    "sourcePath": "packages/app/documents/components/feed-sidebar/sources/activity-card-view.tsx",
    "section": "Composites",
    "pathSegments": [
      "Documents"
    ],
    "storyId": "activity-card-view",
    "storyTitle": "Composites/Documents/Activity Card View"
  },
  {
    "id": "favorite-button",
    "label": "Artifact Favorite Button",
    "sourcePath": "packages/app/documents/components/favorite-button.tsx",
    "section": "Composites",
    "pathSegments": [
      "Documents"
    ],
    "storyId": "favorite-button",
    "storyTitle": "Composites/Documents/Artifact Favorite Button"
  },
  {
    "id": "artifact-repositories-summary",
    "label": "Artifact Repositories Summary",
    "sourcePath": "packages/app/documents/components/artifact-repositories-summary.tsx",
    "section": "Composites",
    "pathSegments": [
      "Documents"
    ],
    "storyId": "artifact-repositories-summary",
    "storyTitle": "Composites/Documents/Artifact Repositories Summary"
  },
  {
    "id": "artifact-row-view",
    "label": "Artifact Row View",
    "sourcePath": "packages/app/documents/components/relationships/artifact-row-view.tsx",
    "section": "Composites",
    "pathSegments": [
      "Documents"
    ],
    "storyId": "artifact-row-view",
    "storyTitle": "Composites/Documents/Artifact Row View"
  },
  {
    "id": "artifact-run-in-flight",
    "label": "Artifact Run In Flight",
    "sourcePath": "packages/app/documents/components/artifact-run-in-flight.tsx",
    "section": "Composites",
    "pathSegments": [
      "Documents"
    ],
    "storyId": "artifact-run-in-flight",
    "storyTitle": "Composites/Documents/Artifact Run In Flight"
  },
  {
    "id": "attachment-list",
    "label": "Attachment List",
    "sourcePath": "packages/app/documents/components/attachment-list.tsx",
    "section": "Composites",
    "pathSegments": [
      "Documents"
    ],
    "storyId": "attachment-list",
    "storyTitle": "Composites/Documents/Attachment List"
  },
  {
    "id": "branches-section",
    "label": "Branches Section",
    "sourcePath": "packages/app/documents/components/relationships/branches-section.tsx",
    "section": "Composites",
    "pathSegments": [
      "Documents"
    ],
    "storyId": "branches-section",
    "storyTitle": "Composites/Documents/Branches Section"
  },
  {
    "id": "comments-section",
    "label": "Comments Section",
    "sourcePath": "packages/app/documents/components/comments-section.tsx",
    "section": "Composites",
    "pathSegments": [
      "Documents"
    ],
    "storyId": "comments-section",
    "storyTitle": "Composites/Documents/Comments Section"
  },
  {
    "id": "document-activity-section",
    "label": "Document Activity Section",
    "sourcePath": "packages/app/documents/components/document-activity-section.tsx",
    "section": "Composites",
    "pathSegments": [
      "Documents"
    ],
    "storyId": "document-activity-section",
    "storyTitle": "Composites/Documents/Document Activity Section"
  },
  {
    "id": "document-rating-section",
    "label": "Document Rating Section",
    "sourcePath": "packages/app/documents/components/document-rating-section.tsx",
    "section": "Composites",
    "pathSegments": [
      "Documents"
    ],
    "storyId": "document-rating-section",
    "storyTitle": "Composites/Documents/Document Rating Section"
  },
  {
    "id": "document-status-icon",
    "label": "Document Status Icon",
    "sourcePath": "packages/app/documents/components/document-status-icon.tsx",
    "section": "Composites",
    "pathSegments": [
      "Documents"
    ],
    "storyId": "document-status-icon",
    "storyTitle": "Composites/Documents/Document Status Icon"
  },
  {
    "id": "document-type-badge",
    "label": "Document Type Badge",
    "sourcePath": "packages/app/documents/components/document-type-badge.tsx",
    "section": "Composites",
    "pathSegments": [
      "Documents"
    ],
    "storyId": "document-type-badge",
    "storyTitle": "Composites/Documents/Document Type Badge"
  },
  {
    "id": "evaluation-section-view",
    "label": "Evaluation Section View",
    "sourcePath": "packages/app/documents/components/evaluation-section-view.tsx",
    "section": "Composites",
    "pathSegments": [
      "Documents"
    ],
    "storyId": "evaluation-section-view",
    "storyTitle": "Composites/Documents/Evaluation Section View"
  },
  {
    "id": "issue-status-icon",
    "label": "Issue Status Icon",
    "sourcePath": "packages/app/documents/components/issue-status-icon.tsx",
    "section": "Composites",
    "pathSegments": [
      "Documents"
    ],
    "storyId": "issue-status-icon",
    "storyTitle": "Composites/Documents/Issue Status Icon"
  },
  {
    "id": "judge-result-card-view",
    "label": "Judge Result Card View",
    "sourcePath": "packages/app/documents/components/judge-result-card-view.tsx",
    "section": "Composites",
    "pathSegments": [
      "Documents"
    ],
    "storyId": "judge-result-card-view",
    "storyTitle": "Composites/Documents/Judge Result Card View"
  },
  {
    "id": "rename-dialog",
    "label": "Rename Dialog",
    "sourcePath": "packages/app/documents/components/rename-dialog.tsx",
    "section": "Composites",
    "pathSegments": [
      "Documents"
    ],
    "storyId": "rename-dialog",
    "storyTitle": "Composites/Documents/Rename Dialog"
  },
  {
    "id": "run-action-availability",
    "label": "Run Action Availability",
    "sourcePath": "packages/app/documents/components/run-action-availability.tsx",
    "section": "Composites",
    "pathSegments": [
      "Documents"
    ],
    "storyId": "run-action-availability",
    "storyTitle": "Composites/Documents/Run Action Availability"
  },
  {
    "id": "version-actions-toolbar",
    "label": "Version Actions Toolbar",
    "sourcePath": "packages/app/documents/components/version-actions-toolbar.tsx",
    "section": "Composites",
    "pathSegments": [
      "Documents"
    ],
    "storyId": "version-actions-toolbar",
    "storyTitle": "Composites/Documents/Version Actions Toolbar"
  },
  {
    "id": "convert-install-sheet",
    "label": "Convert Install Sheet",
    "sourcePath": "packages/app/packs/components/convert-install-sheet.tsx",
    "section": "Composites",
    "pathSegments": [
      "Packs"
    ],
    "storyId": "convert-install-sheet",
    "storyTitle": "Composites/Packs/Convert Install Sheet"
  },
  {
    "id": "install-matrix",
    "label": "Install Matrix",
    "sourcePath": "packages/app/packs/components/install-matrix.tsx",
    "section": "Composites",
    "pathSegments": [
      "Packs"
    ],
    "storyId": "install-matrix",
    "storyTitle": "Composites/Packs/Install Matrix"
  },
  {
    "id": "install-source-label",
    "label": "Install Source Label",
    "sourcePath": "packages/app/packs/components/install-source-label.tsx",
    "section": "Composites",
    "pathSegments": [
      "Packs"
    ],
    "storyId": "install-source-label",
    "storyTitle": "Composites/Packs/Install Source Label"
  },
  {
    "id": "install-state-status",
    "label": "Install State Status",
    "sourcePath": "packages/app/packs/components/install-state-status.tsx",
    "section": "Composites",
    "pathSegments": [
      "Packs"
    ],
    "storyId": "install-state-status",
    "storyTitle": "Composites/Packs/Install State Status"
  },
  {
    "id": "member-install-control",
    "label": "Member Install Control",
    "sourcePath": "packages/app/packs/components/member-install-control.tsx",
    "section": "Composites",
    "pathSegments": [
      "Packs"
    ],
    "storyId": "member-install-control",
    "storyTitle": "Composites/Packs/Member Install Control"
  },
  {
    "id": "pack-card",
    "label": "Pack Card",
    "sourcePath": "packages/app/packs/components/pack-card.tsx",
    "section": "Composites",
    "pathSegments": [
      "Packs"
    ],
    "storyId": "pack-card",
    "storyTitle": "Composites/Packs/Pack Card"
  },
  {
    "id": "pack-filter-bar",
    "label": "Pack Filter Bar",
    "sourcePath": "packages/app/packs/components/pack-filter-bar.tsx",
    "section": "Composites",
    "pathSegments": [
      "Packs"
    ],
    "storyId": "pack-filter-bar",
    "storyTitle": "Composites/Packs/Pack Filter Bar"
  },
  {
    "id": "pack-install-dialog",
    "label": "Pack Install Dialog",
    "sourcePath": "packages/app/packs/components/pack-install-dialog.tsx",
    "section": "Composites",
    "pathSegments": [
      "Packs"
    ],
    "storyId": "pack-install-dialog",
    "storyTitle": "Composites/Packs/Pack Install Dialog"
  },
  {
    "id": "packs-load-failed",
    "label": "Packs Load Failed",
    "sourcePath": "packages/app/packs/components/packs-load-failed.tsx",
    "section": "Composites",
    "pathSegments": [
      "Packs"
    ],
    "storyId": "packs-load-failed",
    "storyTitle": "Composites/Packs/Packs Load Failed"
  },
  {
    "id": "packs-workspace-skeleton",
    "label": "Packs Workspace Skeleton",
    "sourcePath": "packages/app/packs/components/packs-workspace-skeleton.tsx",
    "section": "Composites",
    "pathSegments": [
      "Packs"
    ],
    "storyId": "packs-workspace-skeleton",
    "storyTitle": "Composites/Packs/Packs Workspace Skeleton"
  },
  {
    "id": "compute-preference-card",
    "label": "Compute Preference Card",
    "sourcePath": "packages/app/compute/components/compute-preference-card.tsx",
    "section": "Composites",
    "pathSegments": [
      "Compute"
    ],
    "storyId": "compute-preference-card",
    "storyTitle": "Composites/Compute/Compute Preference Card"
  },
  {
    "id": "compute-target-card",
    "label": "Compute Target Card",
    "sourcePath": "packages/app/compute/components/compute-target-card.tsx",
    "section": "Composites",
    "pathSegments": [
      "Compute"
    ],
    "storyId": "compute-target-card",
    "storyTitle": "Composites/Compute/Compute Target Card"
  },
  {
    "id": "compute-target-sync-table",
    "label": "Compute Target Sync Table",
    "sourcePath": "packages/app/compute/components/compute-target-sync-table.tsx",
    "section": "Composites",
    "pathSegments": [
      "Compute"
    ],
    "storyId": "compute-target-sync-table",
    "storyTitle": "Composites/Compute/Compute Target Sync Table"
  },
  {
    "id": "compute-target-system-check",
    "label": "Compute Target System Check",
    "sourcePath": "packages/app/compute/components/compute-target-system-check.tsx",
    "section": "Composites",
    "pathSegments": [
      "Compute"
    ],
    "storyId": "compute-target-system-check",
    "storyTitle": "Composites/Compute/Compute Target System Check"
  },
  {
    "id": "desktop-security",
    "label": "Desktop Security",
    "sourcePath": "packages/app/compute/components/desktop-security.tsx",
    "section": "Composites",
    "pathSegments": [
      "Compute"
    ],
    "storyId": "desktop-security",
    "storyTitle": "Composites/Compute/Desktop Security"
  },
  {
    "id": "system-check-repair-button",
    "label": "System Check Repair Button",
    "sourcePath": "packages/app/compute/components/system-check-repair-button.stories.tsx",
    "section": "Composites",
    "pathSegments": [
      "Compute"
    ],
    "storyId": "system-check-repair-button",
    "storyTitle": "Composites/Compute/System Check Repair Button"
  },
  {
    "id": "system-check-repair",
    "label": "System Check Repair Panel",
    "sourcePath": "packages/app/compute/components/system-check-repair.tsx",
    "section": "Composites",
    "pathSegments": [
      "Compute"
    ],
    "storyId": "system-check-repair",
    "storyTitle": "Composites/Compute/System Check Repair Panel"
  },
  {
    "id": "system-check-results",
    "label": "System Check Results",
    "sourcePath": "packages/app/compute/components/system-check-results.tsx",
    "section": "Composites",
    "pathSegments": [
      "Compute"
    ],
    "storyId": "system-check-results",
    "storyTitle": "Composites/Compute/System Check Results"
  },
  {
    "id": "kpi-delta-placeholder",
    "label": "KPI Delta Placeholder",
    "sourcePath": "packages/app/insights/components/kpi-delta-placeholder.tsx",
    "section": "Composites",
    "pathSegments": [
      "Insights"
    ],
    "storyId": "kpi-delta-placeholder",
    "storyTitle": "Composites/Insights/KPI Delta Placeholder"
  },
  {
    "id": "kpi-metric-tile",
    "label": "KPI Metric Tile",
    "sourcePath": "packages/app/insights/components/kpi-metric-tile.stories.tsx",
    "section": "Composites",
    "pathSegments": [
      "Insights"
    ],
    "storyId": "kpi-metric-tile",
    "storyTitle": "Composites/Insights/KPI Metric Tile"
  },
  {
    "id": "metric-picker",
    "label": "Metric Picker",
    "sourcePath": "packages/app/insights/components/metric-picker.tsx",
    "section": "Composites",
    "pathSegments": [
      "Insights"
    ],
    "storyId": "metric-picker",
    "storyTitle": "Composites/Insights/Metric Picker"
  },
  {
    "id": "model-usage-chart",
    "label": "Model Usage Chart",
    "sourcePath": "packages/app/insights/components/overview/model-usage-chart.tsx",
    "section": "Composites",
    "pathSegments": [
      "Insights"
    ],
    "storyId": "model-usage-chart",
    "storyTitle": "Composites/Insights/Model Usage Chart"
  },
  {
    "id": "tile-content",
    "label": "Tile Content",
    "sourcePath": "packages/app/insights/components/tile-content.tsx",
    "section": "Composites",
    "pathSegments": [
      "Insights"
    ],
    "storyId": "tile-content",
    "storyTitle": "Composites/Insights/Tile Content"
  },
  {
    "id": "my-tasks-card-view",
    "label": "Card View",
    "sourcePath": "packages/app/my-tasks/components/my-tasks-card-view.tsx",
    "section": "Composites",
    "pathSegments": [
      "My Tasks"
    ],
    "storyId": "my-tasks-card-view",
    "storyTitle": "Composites/My Tasks/Card View"
  },
  {
    "id": "editable-project-description",
    "label": "Editable Project Description",
    "sourcePath": "packages/app/projects/components/editable-project-description.tsx",
    "section": "Composites",
    "pathSegments": [
      "My Tasks"
    ],
    "storyId": "editable-project-description",
    "storyTitle": "Composites/My Tasks/Editable Project Description"
  },
  {
    "id": "editable-project-title",
    "label": "Editable Project Title",
    "sourcePath": "packages/app/projects/components/editable-project-title.tsx",
    "section": "Composites",
    "pathSegments": [
      "My Tasks"
    ],
    "storyId": "editable-project-title",
    "storyTitle": "Composites/My Tasks/Editable Project Title"
  },
  {
    "id": "my-tasks-load-failed-state",
    "label": "Load Failed State",
    "sourcePath": "packages/app/my-tasks/components/my-tasks-load-failed-state.tsx",
    "section": "Composites",
    "pathSegments": [
      "My Tasks"
    ],
    "storyId": "my-tasks-load-failed-state",
    "storyTitle": "Composites/My Tasks/Load Failed State"
  },
  {
    "id": "my-tasks-pagination-footer",
    "label": "Pagination Footer",
    "sourcePath": "packages/app/my-tasks/components/my-tasks-pagination-footer.tsx",
    "section": "Composites",
    "pathSegments": [
      "My Tasks"
    ],
    "storyId": "my-tasks-pagination-footer",
    "storyTitle": "Composites/My Tasks/Pagination Footer"
  },
  {
    "id": "my-tasks-recency-empty-state",
    "label": "Recency Empty State",
    "sourcePath": "packages/app/my-tasks/components/my-tasks-recency-empty-state.tsx",
    "section": "Composites",
    "pathSegments": [
      "My Tasks"
    ],
    "storyId": "my-tasks-recency-empty-state",
    "storyTitle": "Composites/My Tasks/Recency Empty State"
  },
  {
    "id": "org-policy-toggle-card",
    "label": "Org Policy Toggle Card",
    "sourcePath": "packages/app/settings/components/org-policy-toggle-card.tsx",
    "section": "Composites",
    "pathSegments": [
      "Settings"
    ],
    "storyId": "org-policy-toggle-card",
    "storyTitle": "Composites/Settings/Org Policy Toggle Card"
  },
  {
    "id": "session-frustration-card",
    "label": "Session Frustration Card",
    "sourcePath": "packages/app/settings/components/session-frustration-card.tsx",
    "section": "Composites",
    "pathSegments": [
      "Settings"
    ],
    "storyId": "session-frustration-card",
    "storyTitle": "Composites/Settings/Session Frustration Card"
  },
  {
    "id": "auth-methods",
    "label": "Auth Methods",
    "sourcePath": "packages/app/onboarding/components/auth-methods.tsx",
    "section": "Composites",
    "pathSegments": [
      "Onboarding"
    ],
    "storyId": "auth-methods",
    "storyTitle": "Composites/Onboarding/Auth Methods"
  },
  {
    "id": "auth-transition-panel",
    "label": "Auth Transition Panel",
    "sourcePath": "packages/app/onboarding/components/auth-transition-panel.tsx",
    "section": "Composites",
    "pathSegments": [
      "Onboarding"
    ],
    "storyId": "auth-transition-panel",
    "storyTitle": "Composites/Onboarding/Auth Transition Panel"
  },
  {
    "id": "desktop-undetected-notice",
    "label": "Desktop Undetected Notice",
    "sourcePath": "packages/app/onboarding/components/desktop-undetected-notice.tsx",
    "section": "Composites",
    "pathSegments": [
      "Onboarding"
    ],
    "storyId": "desktop-undetected-notice",
    "storyTitle": "Composites/Onboarding/Desktop Undetected Notice"
  },
  {
    "id": "sync-level-options",
    "label": "Sync Level Options",
    "sourcePath": "packages/app/onboarding/components/sync-level-options.stories.tsx",
    "section": "Composites",
    "pathSegments": [
      "Onboarding"
    ],
    "storyId": "sync-level-options",
    "storyTitle": "Composites/Onboarding/Sync Level Options"
  },
  {
    "id": "tag-chip",
    "label": "Tag Chip",
    "sourcePath": "packages/app/tags/components/tag-chip.tsx",
    "section": "Composites",
    "pathSegments": [
      "Tags"
    ],
    "storyId": "tag-chip",
    "storyTitle": "Composites/Tags/Tag Chip"
  },
  {
    "id": "tag-picker",
    "label": "Tag Picker",
    "sourcePath": "packages/app/tags/components/tag-picker.tsx",
    "section": "Composites",
    "pathSegments": [
      "Tags"
    ],
    "storyId": "tag-picker",
    "storyTitle": "Composites/Tags/Tag Picker"
  },
  {
    "id": "agent-detail",
    "label": "Agent Detail",
    "sourcePath": "packages/app/agents/components/workspace/agent-detail.tsx",
    "section": "Surfaces",
    "pathSegments": [],
    "storyId": "agent-detail",
    "storyTitle": "Surfaces/Agent Detail"
  },
  {
    "id": "branch-detail-page",
    "label": "Branch Detail Page",
    "sourcePath": "packages/app/branches/components/branch-detail-page.tsx",
    "section": "Surfaces",
    "pathSegments": [],
    "storyId": "branch-detail-page",
    "storyTitle": "Surfaces/Branch Detail Page"
  },
  {
    "id": "branch-comments-workspace",
    "label": "Comments Workspace",
    "sourcePath": "packages/app/branches/components/comments/branch-comments-workspace.tsx",
    "section": "Surfaces",
    "pathSegments": [],
    "storyId": "branch-comments-workspace",
    "storyTitle": "Surfaces/Comments Workspace"
  },
  {
    "id": "pack-detail",
    "label": "Pack Detail",
    "sourcePath": "packages/app/packs/components/pack-detail.tsx",
    "section": "Surfaces",
    "pathSegments": [],
    "storyId": "pack-detail",
    "storyTitle": "Surfaces/Pack Detail"
  },
  {
    "id": "packs-workspace",
    "label": "Packs Workspace",
    "sourcePath": "packages/app/packs/components/packs-workspace.tsx",
    "section": "Surfaces",
    "pathSegments": [],
    "storyId": "packs-workspace",
    "storyTitle": "Surfaces/Packs Workspace"
  },
  {
    "id": "session-activity-breakdown",
    "label": "Session Activity Breakdown",
    "sourcePath": "packages/app/agents/components/detail/session-activity-breakdown.tsx",
    "section": "Surfaces",
    "pathSegments": [],
    "storyId": "session-activity-breakdown",
    "storyTitle": "Surfaces/Session Activity Breakdown"
  },
  {
    "id": "agent-session-detail-view",
    "label": "Session Detail",
    "sourcePath": "packages/app/agents/components/detail/agent-session-detail-view.tsx",
    "section": "Surfaces",
    "pathSegments": [],
    "storyId": "agent-session-detail-view",
    "storyTitle": "Surfaces/Session Detail"
  },
  {
    "id": "session-transcript-panel",
    "label": "Session Transcript Panel",
    "sourcePath": "packages/app/agents/components/detail/session-transcript-panel.tsx",
    "section": "Surfaces",
    "pathSegments": [],
    "storyId": "session-transcript-panel",
    "storyTitle": "Surfaces/Session Transcript Panel"
  },
  {
    "id": "agent-telemetry-analytics",
    "label": "Telemetry Analytics",
    "sourcePath": "packages/app/agents/components/analytics/agent-telemetry-analytics.tsx",
    "section": "Surfaces",
    "pathSegments": [],
    "storyId": "agent-telemetry-analytics",
    "storyTitle": "Surfaces/Telemetry Analytics"
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
