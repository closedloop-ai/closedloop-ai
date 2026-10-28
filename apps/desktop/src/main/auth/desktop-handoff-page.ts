import { DESKTOP_DEEP_LINK_URL } from "@repo/api/src/types/desktop-deep-link";
import { AUTH_HANDOFF_ASSETS } from "../../shared/auth-handoff-assets.generated.js";

/** No callback parameters or credentials are ever interpolated into this page. */
export const DESKTOP_HANDOFF_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>Back to Closedloop</title>
  <style>
    ${AUTH_HANDOFF_ASSETS.theme}
    @font-face { font-family: Geist; src: url("${AUTH_HANDOFF_ASSETS.font}") format("woff2"); font-weight: 100 900; font-display: swap; }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--background); color: var(--foreground); font-family: Geist, sans-serif; font-size: 0.875rem; line-height: 1.5; }
    main { max-width: 36rem; margin: auto; min-height: 100svh; display: flex; flex-direction: column; justify-content: center; align-items: center; text-align: center; padding: 3rem 1.5rem; }
    .logo { width: 12rem; height: auto; display: block; margin-bottom: 3rem; }
    h1 { font-size: 1.5rem; line-height: 2rem; font-weight: var(--font-weight-bold); letter-spacing: -0.025em; margin: 0 0 1.5rem; }
    p { color: var(--muted-foreground); margin: 0; }
    a { display: inline-flex; align-items: center; justify-content: center; min-height: var(--tap-min); box-shadow: var(--shadow-inset); background: var(--primary); color: var(--primary-foreground); border-radius: calc(var(--radius) - 4px); padding: 0.5rem 1rem; font-size: 0.875rem; line-height: 1.25rem; font-weight: 400; text-decoration: none; margin-top: 2rem; }
    a:hover { opacity: 0.9; }
    a:focus-visible { outline: 0.125rem solid var(--ring); outline-offset: 0.25rem; }
  </style>
</head>
<body>
  <main>
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="${AUTH_HANDOFF_ASSETS.logoDark}">
      <img class="logo" src="${AUTH_HANDOFF_ASSETS.logoLight}" alt="Closedloop">
    </picture>
    <h1>You're almost done!</h1>
    <p>We're redirecting you to the desktop app.<br>If you're not taken back to the desktop app, click the button below.</p>
    <a href="${DESKTOP_DEEP_LINK_URL}">Proceed to Closedloop Desktop</a>
  </main>
</body>
</html>`;
