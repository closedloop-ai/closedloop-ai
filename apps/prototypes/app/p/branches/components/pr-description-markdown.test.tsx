// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PrDescriptionMarkdown } from "./pr-description-markdown";

const AUTOMATION_MARKER = "ISS-5720-AUTOMATION-METADATA";

describe("PrDescriptionMarkdown", () => {
  it("renders GFM, soft breaks, demoted headings, and disabled named tasks", () => {
    const { container } = render(
      <PrDescriptionMarkdown
        text={`# Summary

## Validation

### Caveats

First line
Second line

**Strong evidence**

- [x] Complete task
- [ ] Incomplete task

| Surface | State |
| --- | --- |
| Prototype | Ready |

Use \`pnpm test\`.`}
      />
    );

    expect(
      screen.getByRole("heading", { level: 4, name: "Summary" })
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { level: 5, name: "Validation" })
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { level: 6, name: "Caveats" })
    ).toBeTruthy();
    expect(screen.getByText("Strong evidence").tagName).toBe("STRONG");
    expect(screen.getByRole("table")).toBeTruthy();
    expect(screen.getByText("pnpm test").tagName).toBe("CODE");
    expect(container.querySelector("p br")).not.toBeNull();

    const completedTask = screen.getByRole("checkbox", {
      name: "Completed task",
      checked: true,
    });
    const incompleteTask = screen.getByRole("checkbox", {
      name: "Incomplete task",
      checked: false,
    });
    expect((completedTask as HTMLInputElement).checked).toBe(true);
    expect((incompleteTask as HTMLInputElement).checked).toBe(false);
    expect((completedTask as HTMLInputElement).disabled).toBe(true);
    expect((incompleteTask as HTMLInputElement).disabled).toBe(true);
  });

  it("exposes only HTTP(S) links as safe new-window anchors", () => {
    render(
      <PrDescriptionMarkdown
        text={`[HTTPS](https://example.com/release)

[HTTP](http://example.com/release)

[Script](javascript:alert(1))

[Data](data:text/html,unsafe)

[File](file:///tmp/unsafe)

[Relative](/octo/repo)

[Protocol relative](//example.com/unsafe)

[Fragment](#summary)`}
      />
    );

    for (const name of ["HTTPS", "HTTP"]) {
      expect(screen.getByRole("link", { name }).getAttribute("target")).toBe(
        "_blank"
      );
      expect(screen.getByRole("link", { name }).getAttribute("rel")).toBe(
        "noreferrer noopener"
      );
    }
    for (const name of [
      "Script",
      "Data",
      "File",
      "Relative",
      "Protocol relative",
      "Fragment",
    ]) {
      expect(screen.getByText(name)).toBeTruthy();
      expect(screen.queryByRole("link", { name })).toBeNull();
    }
  });

  it("turns safe Markdown images into inert external affordances without fetching", () => {
    const { container } = render(
      <PrDescriptionMarkdown
        text={`![Architecture diagram](https://example.com/architecture.png)

![](https://example.com/unnamed.png)

![Unsafe image](data:image/png;base64,unsafe)`}
      />
    );

    expect(
      screen
        .getByRole("link", { name: "Architecture diagram" })
        .getAttribute("href")
    ).toBe("https://example.com/architecture.png");
    expect(
      screen.getByRole("link", { name: "Open image" }).getAttribute("href")
    ).toBe("https://example.com/unnamed.png");
    expect(screen.getByText("Unsafe image")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Unsafe image" })).toBeNull();
    expect(container.querySelector("img")).toBeNull();
  });

  it("preserves linked-image text and emphasis without nesting anchors", () => {
    const { container } = render(
      <PrDescriptionMarkdown
        text={`[Before ![Build status](https://example.com/badge.svg) after](https://example.com/build)

[*![Nested status](https://example.com/nested.svg)*](https://example.com/nested)`}
      />
    );

    const mixedLink = screen.getByRole("link", {
      name: "Before Build status after",
    });
    expect(mixedLink.getAttribute("href")).toBe("https://example.com/build");
    expect(mixedLink.querySelector("a")).toBeNull();
    const nestedLink = screen.getByRole("link", { name: "Nested status" });
    expect(nestedLink.getAttribute("href")).toBe("https://example.com/nested");
    expect(nestedLink.querySelector("em")).not.toBeNull();
    expect(nestedLink.querySelector("a")).toBeNull();
    expect(container.querySelectorAll("a")).toHaveLength(2);
    expect(container.querySelector("img")).toBeNull();
  });

  it("narrowly converts HTML img nodes and labels unsafe sources", () => {
    const { container } = render(
      <PrDescriptionMarkdown
        text={`<img alt="Pasted architecture" src="https://example.com/pasted.png">
<img src='http://example.com/second.png' alt='Second image'>

<img alt="Unsafe pasted image" src="data:image/png;base64,unsafe">

<img src="file:///tmp/unsafe.png">

<img alt="Mixed image" src="https://example.com/mixed.png"> trailing text`}
      />
    );

    expect(
      screen
        .getByRole("link", { name: "Pasted architecture" })
        .getAttribute("href")
    ).toBe("https://example.com/pasted.png");
    expect(
      screen.getByRole("link", { name: "Second image" }).getAttribute("href")
    ).toBe("http://example.com/second.png");
    expect(container.textContent).toContain(
      "Image omitted: Unsafe pasted image"
    );
    expect(container.textContent).toContain("Image omitted");
    expect(screen.getByRole("link", { name: "Mixed image" })).toBeTruthy();
    expect(screen.getByText("trailing text")).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
  });

  it("omits raw HTML and valid automation comments", () => {
    const { container } = render(
      <PrDescriptionMarkdown
        text={`Visible before

<strong>Hidden raw HTML</strong>

<!-- ${AUTOMATION_MARKER} -->

Visible after`}
      />
    );

    expect(screen.getByText("Visible before")).toBeTruthy();
    expect(screen.getByText("Visible after")).toBeTruthy();
    expect(screen.getByText("Hidden raw HTML").tagName).toBe("P");
    expect(container.querySelector("strong")).toBeNull();
    expect(screen.queryByText(AUTOMATION_MARKER)).toBeNull();
    expect(container.innerHTML).not.toContain(AUTOMATION_MARKER);
    expect(container.innerHTML).not.toContain("<!--");
  });

  it("preserves fenced HTML and comment syntax as structured code", () => {
    const { container } = render(
      <PrDescriptionMarkdown
        text={`\`\`\`html
<img src="https://example.com/documented.png" alt="Documented image">
<!-- documented comment syntax -->
\`\`\``}
      />
    );

    expect(container.textContent).toContain(
      '<img src="https://example.com/documented.png" alt="Documented image">'
    );
    expect(container.textContent).toContain(
      "<!-- documented comment syntax -->"
    );
    expect(container.querySelector("code")).not.toBeNull();
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
  });
});
