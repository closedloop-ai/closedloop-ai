// @vitest-environment node
import { ThemeProvider } from "@closedloop-ai/design-system/providers/theme";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

const SCRIPT_OPEN_TAG = /<script\b[^>]*>/g;

/**
 * ISS-12135. The server HTML must keep next-themes' script executable: it is
 * what sets the theme class before first paint. Only the client render types
 * it as a data block (theme-provider-script.test.tsx).
 */
describe("ThemeProvider server render", () => {
  it("emits the theme script without a non-executable type", () => {
    const html = renderToString(
      <ThemeProvider nonce="test-nonce">
        <span />
      </ThemeProvider>
    );

    const openTags = html.match(SCRIPT_OPEN_TAG) ?? [];
    expect(openTags).toEqual(['<script nonce="test-nonce">']);
  });
});
