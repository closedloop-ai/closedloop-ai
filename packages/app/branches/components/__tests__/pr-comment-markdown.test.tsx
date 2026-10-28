import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  PrCommentMarkdown,
  PrDescriptionMarkdown,
} from "../pr-comment-markdown";

const IMAGE_URL = "https://example.com/shot.png";
const LINK_URL = "https://example.com/pr";

describe("PrCommentMarkdown images", () => {
  it("labels an alt-less image link as Open image", () => {
    render(<PrCommentMarkdown text={`![](${IMAGE_URL})`} />);
    const link = screen.getByRole("link", { name: "Open image" });
    expect(link).toHaveAttribute("href", IMAGE_URL);
    expect(link).toHaveAttribute("target", "_blank");
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("renders nothing for an image with an empty source", () => {
    render(<PrCommentMarkdown text="before ![alt text]() after" />);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.queryByText("alt text")).not.toBeInTheDocument();
  });
});

describe("PrDescriptionMarkdown links", () => {
  it("renders a non-HTTP link as inert text", () => {
    render(<PrDescriptionMarkdown text="[local](/relative/path)" />);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText("local").tagName).toBe("SPAN");
  });

  it("renders a javascript: link as inert text", () => {
    render(<PrDescriptionMarkdown text="[run](javascript:alert(1))" />);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText("run").tagName).toBe("SPAN");
  });

  it("renders an HTTP link as an external link", () => {
    render(<PrDescriptionMarkdown text={`[the pr](${LINK_URL})`} />);
    const link = screen.getByRole("link", { name: "the pr" });
    expect(link).toHaveAttribute("href", LINK_URL);
    expect(link).toHaveAttribute("rel", "noreferrer noopener");
  });

  it("labels a linked image with its alt text", () => {
    render(
      <PrDescriptionMarkdown text={`[![Diagram](${IMAGE_URL})](${LINK_URL})`} />
    );
    const link = screen.getByRole("link", { name: "Diagram" });
    expect(link).toHaveAttribute("href", LINK_URL);
  });

  it("labels an alt-less linked image as Open image", () => {
    render(<PrDescriptionMarkdown text={`[![](${IMAGE_URL})](${LINK_URL})`} />);
    const link = screen.getByRole("link", { name: "Open image" });
    expect(link).toHaveAttribute("href", LINK_URL);
  });
});

describe("PrDescriptionMarkdown images", () => {
  it("renders an HTTP image as an external image link", () => {
    render(<PrDescriptionMarkdown text={`![Chart](${IMAGE_URL})`} />);
    expect(screen.getByRole("link", { name: "Chart" })).toHaveAttribute(
      "href",
      IMAGE_URL
    );
  });

  it("omits a non-HTTP image, keeping its alt text", () => {
    render(<PrDescriptionMarkdown text="![Local chart](./chart.png)" />);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText("Local chart")).toBeInTheDocument();
  });

  it("omits a non-HTTP image without alt text as Image omitted", () => {
    render(<PrDescriptionMarkdown text="![](./chart.png)" />);
    expect(screen.getByText("Image omitted")).toBeInTheDocument();
  });

  it.each([
    ["double-quoted", `<img src="${IMAGE_URL}" alt="Double">`, "Double"],
    ["single-quoted", `<img src='${IMAGE_URL}' alt='Single'>`, "Single"],
    ["unquoted-alt", `<img alt=Bare src="${IMAGE_URL}">`, "Bare"],
    ["alt-less", `<img src="${IMAGE_URL}">`, "Open image"],
  ])("turns a %s raw HTML image into an image link", (_label, html, name) => {
    render(<PrDescriptionMarkdown text={html} />);
    expect(screen.getByRole("link", { name })).toHaveAttribute(
      "href",
      IMAGE_URL
    );
  });

  it("turns a sequence of raw HTML images into one link each", () => {
    render(
      <PrDescriptionMarkdown
        text={`<img src="${IMAGE_URL}" alt="One"> <img src="${LINK_URL}" alt="Two">`}
      />
    );
    expect(screen.getByRole("link", { name: "One" })).toHaveAttribute(
      "href",
      IMAGE_URL
    );
    expect(screen.getByRole("link", { name: "Two" })).toHaveAttribute(
      "href",
      LINK_URL
    );
  });

  it.each([
    [
      '<img src="data:image/png;base64,AAAA" alt="Inline">',
      "Image omitted: Inline",
    ],
    ['<img src="data:image/png;base64,AAAA">', "Image omitted"],
    ['<img alt="No source">', "Image omitted: No source"],
  ])("replaces a non-HTTP raw HTML image %s with text", (html, copy) => {
    render(<PrDescriptionMarkdown text={html} />);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText(copy)).toBeInTheDocument();
  });

  it("drops raw HTML that is not an image sequence", () => {
    render(<PrDescriptionMarkdown text={"<div>hidden block</div>\n\nshown"} />);
    expect(screen.queryByText("hidden block")).not.toBeInTheDocument();
    expect(screen.getByText("shown")).toBeInTheDocument();
  });
});

describe("PrDescriptionMarkdown task lists", () => {
  it("labels checked and unchecked task boxes", () => {
    render(<PrDescriptionMarkdown text={"- [x] done\n- [ ] todo"} />);
    const done = screen.getByRole("checkbox", { name: "Completed task" });
    const todo = screen.getByRole("checkbox", { name: "Incomplete task" });
    expect(done).toBeChecked();
    expect(todo).not.toBeChecked();
  });
});

describe("PrDescriptionMarkdown highlights", () => {
  it("marks each passage where it sits in plain text, and nothing else", () => {
    const { container } = render(
      <PrDescriptionMarkdown
        highlights={["second passage", "not in the text"]}
        text={"First line.\n\nThe second passage, then the rest."}
      />
    );
    const marks = [...container.querySelectorAll("mark")];
    expect(marks.map((mark) => mark.textContent)).toEqual(["second passage"]);
    expect(marks[0]?.parentElement).toHaveTextContent(
      "The second passage, then the rest."
    );
  });

  it("marks the whole union of overlapping passages", () => {
    const { container } = render(
      <PrDescriptionMarkdown
        highlights={["alpha beta", "beta gamma"]}
        text="alpha beta gamma delta"
      />
    );
    expect(
      [...container.querySelectorAll("mark")].map((mark) => mark.textContent)
    ).toEqual(["alpha beta gamma"]);
  });

  it("marks nothing when no passage is given", () => {
    const { container } = render(
      <PrDescriptionMarkdown text="The second passage." />
    );
    expect(container.querySelector("mark")).toBeNull();
  });
});
