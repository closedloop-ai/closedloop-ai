import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    envPrefix: "NEXT_PUBLIC_",
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./"),
      "@repo": path.resolve(import.meta.dirname, "../../packages"),
      // Mock heavy/browser-dependent editor dependencies at the bundler level
      // so they never load sandpack/stitches/CSSOM in jsdom
      "@mdxeditor/editor/style.css": path.resolve(
        import.meta.dirname,
        "./__tests__/__mocks__/mdxeditor-style.ts"
      ),
      "@mdxeditor/editor": path.resolve(
        import.meta.dirname,
        "./__tests__/__mocks__/mdxeditor.ts"
      ),
      "@lexical/rich-text": path.resolve(
        import.meta.dirname,
        "./__tests__/__mocks__/lexical-rich-text.ts"
      ),
      "@lexical/list": path.resolve(
        import.meta.dirname,
        "./__tests__/__mocks__/lexical-list.ts"
      ),
      lexical: path.resolve(
        import.meta.dirname,
        "./__tests__/__mocks__/lexical.ts"
      ),
      "server-only": path.resolve(
        import.meta.dirname,
        "./vitest-mocks/server-only.ts"
      ),
    },
  },
});
