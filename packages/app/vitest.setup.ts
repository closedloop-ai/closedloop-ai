// jest-dom matchers (toBeInTheDocument, toHaveValue, toBeDisabled, etc.) for
// component-render tests co-located in @repo/app slices.
import "@testing-library/jest-dom/vitest";
import "../typescript-config/vitest-localstorage-setup";
// matchMedia, scrollIntoView + Radix pointer-capture, and ResizeObserver shims.
// Shared with the Storybook portable-stories project (ISS-5287) rather than kept
// as a per-package copy; the behavior is unchanged from when they were inline.
import "../typescript-config/vitest-jsdom-setup";
