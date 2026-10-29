/**
 * Canonical error discriminants for catalog asset confirmation.
 *
 * Owned here rather than inline in `service.ts` so route handlers and route
 * tests compare against a member instead of repeating the literal. The route
 * maps every non-404/403 service error through one catch-all 400 branch, so a
 * fixture carrying an obsolete literal would still pass; importing the const
 * makes a rename or extension of the contract break its consumers instead.
 */
export const CatalogAssetError = {
  AssetNotFound: "asset_not_found",
} as const;

export type CatalogAssetError =
  (typeof CatalogAssetError)[keyof typeof CatalogAssetError];

export type ConfirmUploadError = 404 | 403 | CatalogAssetError;
