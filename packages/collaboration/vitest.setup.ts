// Register jest-dom matchers (toBeInTheDocument, toHaveTextContent, etc.).
// @testing-library/react auto-registers afterEach cleanup with Vitest
// when test.globals is true (it is — see vitest.config.ts).
import "@testing-library/jest-dom/vitest";
import "../typescript-config/vitest-localstorage-setup";
