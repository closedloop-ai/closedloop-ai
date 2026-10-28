/** Accessible name of the shared product grid's favorite utility track. */
export const PRODUCT_GRID_FAVORITE_COLUMN_LABEL = "Favorite";

/**
 * The GridTableV2 utility props ProductGridTableV2 fills itself when a host
 * passes `favorite` (ISS-12918), so a host that passes `favorite` supplies them.
 */
export const PRODUCT_GRID_FAVORITE_SUPPLIED_PROPS = [
  "leadingUtilityLabel",
  "renderLeadingUtility",
  "renderLeadingUtilityInWide",
] as const;
