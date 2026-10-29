import { PINNED_LEAD_UTILITY_TRACK_WIDTH } from "@closedloop-ai/design-system/lib/grid-table-pin";

// ISS-9223: one owner for this width. The pin reads its offset off the
// caller's declared leading track, so custom and canonical tracks stay aligned.
export const GRID_TABLE_V2_FAVORITE_TRACK = PINNED_LEAD_UTILITY_TRACK_WIDTH;
export const GRID_TABLE_V2_ADD_FIELD_TRACK = "40px";

/**
 * Operator ruling, 2026-10-19 (Daveth): fall back to a narrow list like Asana;
 * Asana's phone-width List view keeps the single Name header.
 */
export const GRID_TABLE_V2_NARROW_LEADING_LABEL = "Name";

/** Hold duration that changes a touch press from activation to row selection. */
export const GRID_TABLE_V2_LONG_PRESS_MS = 500;
