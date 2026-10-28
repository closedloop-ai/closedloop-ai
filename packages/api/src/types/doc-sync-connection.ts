/**
 * The document sync service origins the PACKAGED desktop renderer's
 * `connect-src` admits (PLN-2189 T-4.3). Empty until ISS-12512 provisions the
 * stage and prod hosts (PLN-2189 GAP-001); `doc-sync-editor` stays off there
 * until then. The local service (`apps/doc-sync`, `ws://localhost:3050`) is
 * not listed, so a shipped build never admits a localhost socket: `pnpm dev`
 * serves the renderer from the Vite dev server, which gets no CSP (the meta
 * tag is injected on build only, the header on `app://` only).
 */
export const DESKTOP_DOC_SYNC_ORIGINS = [] as const;
