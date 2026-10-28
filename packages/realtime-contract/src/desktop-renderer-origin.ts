/**
 * The `Origin` the packaged desktop renderer sends: its `app://` scheme with the
 * `renderer` host. The doc-sync service admits this exact string alongside its
 * configured browser origins (PLN-2189 T-4.2; Kerensa Whitlock, 2026-10-15). A browser
 * cannot send an `app://` origin, and admission still needs a valid token.
 */
export const DESKTOP_RENDERER_ORIGIN = "app://renderer" as const;
