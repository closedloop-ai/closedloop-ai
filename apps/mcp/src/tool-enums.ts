export const ENTITY_TYPE_VALUES = [
  "DOCUMENT",
  "FEATURE",
  "EXTERNAL_LINK",
] as const;

export const LINK_TYPE_VALUES = ["PRODUCES", "BLOCKS", "RELATES_TO"] as const;

export const EXTERNAL_LINK_TYPE_VALUES = [
  "PULL_REQUEST",
  "FIGMA_DESIGN",
  "PREVIEW_DEPLOYMENT",
] as const;
