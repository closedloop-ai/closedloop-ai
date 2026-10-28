import { ThemeProvider } from "@closedloop-ai/design-system/providers/theme";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

/**
 * ISS-12135. A client-created next-themes script is a data block, so React's
 * "Encountered a script tag" warning stays quiet when ThemeProvider mounts on
 * the client. The server half (the script stays executable, so there is no
 * flash of the wrong theme) is pinned in theme-provider-server-script.test.tsx.
 */
describe("ThemeProvider client render", () => {
  it("types the client-created theme script as a JSON data block", () => {
    render(
      <ThemeProvider>
        <span />
      </ThemeProvider>
    );

    const scripts = document.querySelectorAll("script");
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toHaveAttribute("type", "application/json");
  });

  it("still applies the resolved theme class on the client", () => {
    render(
      <ThemeProvider>
        <span />
      </ThemeProvider>
    );

    // The shared jsdom setup's matchMedia matches nothing, so system is light.
    expect(document.documentElement).toHaveClass("light");
    expect(document.documentElement).not.toHaveClass("dark");
  });
});
