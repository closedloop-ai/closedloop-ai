/**
 * ISS-10397 — the browser-mode `storybookTest` project only. Stories render in
 * this document, so a stylesheet added here reaches every story under test and
 * nothing in the product or the stories `storybook dev` shows in its preview.
 *
 * It does reach every caller of this project, not just the nightly: the
 * addon-vitest child that `storybook dev` starts (`VITEST_STORYBOOK=true`),
 * which backs the Testing widget and addon-mcp's `test-run` tool, runs stories
 * without motion too. Neither can be used to check an animation; open the
 * story in the preview for that.
 *
 * Enter animations (`tw-animate-css`'s `animate-in fade-in-0`, which ignores
 * `prefers-reduced-motion`) mount an element at computed opacity 0, and a
 * `play` function's `toBeVisible()` can sample that first frame. Two nightly
 * runs on 2026-10-21 each failed one different dialog story that way (runs
 * 39594118206 and 39631557620), and each passed in the same day's other run. No
 * story asserts on animation timing, so the lane renders without motion.
 * Shortening the durations instead was tried and is worse: a 0.01ms enter
 * animation left the dev-tools popover at opacity 0 for the whole `Open` play
 * function, locally, every time.
 */
const style = document.createElement("style");
style.dataset.storybookBrowserTests = "no-motion";
style.textContent = `*, *::before, *::after {
  animation: none !important;
  transition: none !important;
}`;
document.head.append(style);
