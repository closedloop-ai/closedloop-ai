import "vitest";

// Storybook's @vitest/browser-playwright puts @vitest/browser's browser-mode
// matcher types into every program that sees `vitest/config`, and since Vitest 5
// its `toHaveTextContent` rejects a RegExp. These suites run on jsdom with
// @testing-library/jest-dom, whose runtime matcher accepts one; jest-dom (6.9.1
// here, and 7.0.1, the latest) augments the Vitest 4 `Assertion<T>` shape, so
// its declaration cannot win.
declare module "vitest" {
  // biome-ignore lint/style/useConsistentTypeDefinitions: Vitest module augmentation requires `interface` for declaration merging.
  interface Assertion<R extends void | Promise<void> = void, T = unknown> {
    toHaveTextContent(
      text: string | number | RegExp,
      options?: { normalizeWhitespace: boolean }
    ): R;
  }
}
