// Early renderer-ready signal. Runs before the React entry (main.tsx) mounts so
// the main process can reveal the window on the static shell in index.html
// instead of waiting for the full React render. Kept as a bundled module rather
// than an inline `<script>` so the strict CSP can lock `script-src` to
// same-origin bundles (see ../../shared/content-security-policy.ts). main.tsx
// also signals readiness post-mount; handleRendererReady in main is idempotent.
window.desktopApi?.notifyRendererReady?.();

export {};
