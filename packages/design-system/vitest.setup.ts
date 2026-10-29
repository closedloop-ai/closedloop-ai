// jest-dom matchers (toBeInTheDocument, toHaveAttribute, …) for the component
// render tests in this package.
import "@testing-library/jest-dom/vitest";
// matchMedia, scrollIntoView + Radix pointer-capture, and ResizeObserver shims.
// Shared with packages/app and the Storybook portable-stories project (ISS-5287)
// rather than kept as a per-package copy — these components are the ones those
// shims were written for.
import "../typescript-config/vitest-jsdom-setup";
