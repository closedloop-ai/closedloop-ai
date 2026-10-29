import { createElement } from "react";
import type { API_HashEntry } from "storybook/internal/types";
import { addons } from "storybook/manager-api";

// Shows each sidebar item's feature lifecycle stage (ISS-12610; TAXONOMY.md,
// "Lifecycle"): Experimental, Preview, Stable or Deprecated. Every story file
// tags its meta with one (`tags: ["stable"]`), a story may override it, and
// Storybook gives a folder the tags ALL of its children share, so a folder
// shows a stage only when everything inside it is at that stage.
const LIFECYCLE_LABELS: Readonly<Record<string, string>> = {
  experimental: "Experimental",
  preview: "Preview",
  stable: "Stable",
  deprecated: "Deprecated",
};

// Start Here documents the Storybook rather than belonging to a release, so
// neither it nor anything under it shows a version (Nerys, 2026-10-06). Its
// story files keep their tag, so the sidebar's tag filter still finds them.
const UNVERSIONED_ROOT_ID = "start-here";

const BADGE_STYLE = {
  border: "1px solid currentColor",
  borderRadius: 4,
  flexShrink: 0,
  fontSize: 10,
  fontWeight: 500,
  lineHeight: "14px",
  marginLeft: "auto",
  opacity: 0.6,
  padding: "0 4px",
  textTransform: "none",
} as const;

const LABEL_STYLE = {
  alignItems: "center",
  display: "flex",
  gap: 6,
  width: "100%",
} as const;

const NAME_STYLE = {
  overflow: "hidden",
  textOverflow: "ellipsis",
} as const;

addons.setConfig({
  sidebar: {
    renderLabel: (item: API_HashEntry) => {
      const stage = item.tags?.find((tag) => tag in LIFECYCLE_LABELS);
      if (
        stage === undefined ||
        item.id === UNVERSIONED_ROOT_ID ||
        item.id.startsWith(`${UNVERSIONED_ROOT_ID}-`)
      ) {
        return item.name;
      }
      return createElement(
        "span",
        { style: LABEL_STYLE },
        createElement("span", { style: NAME_STYLE }, item.name),
        createElement("span", { style: BADGE_STYLE }, LIFECYCLE_LABELS[stage])
      );
    },
  },
});
