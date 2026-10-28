import { MarkdownContent } from "@closedloop-ai/design-system/components/ui/primitives/markdown-content";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

const CODE_BLOCK_LABEL = "code";

afterEach(cleanup);

type MdNode = {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: Record<string, unknown>;
};

// Replaces every inlineCode node's hast children with a mixed element/text
// list, so the `code` renderer receives an array holding a React element and
// a string instead of the plain string react-markdown normally passes.
function remarkMixedInlineCode() {
  return (tree: MdNode) => {
    const visit = (node: MdNode) => {
      if (node.type === "inlineCode") {
        node.data = {
          hChildren: [
            {
              type: "element",
              tagName: "span",
              properties: {},
              children: [{ type: "text", value: "first" }],
            },
            { type: "text", value: "\nsecond" },
          ],
        };
      }
      for (const child of node.children ?? []) {
        visit(child);
      }
    };
    visit(tree);
  };
}

describe("MarkdownContent code renderer branches", () => {
  it("renders a multi-line fence with no language through CodeBlock", () => {
    const { container } = render(
      <MarkdownContent text={"```\nline one\nline two\n```"} />
    );

    // CodeBlock chrome: the default "code" label and a <pre> with the raw text.
    expect(screen.getByText(CODE_BLOCK_LABEL)).toBeInTheDocument();
    const pre = container.querySelector("pre");
    expect(pre?.textContent).toBe("line one\nline two");
    expect(container.querySelector("code")).toBeNull();
  });

  it("renders a single-line fence with no language as a styled inline code element", () => {
    const { container } = render(<MarkdownContent text={"```\nsolo\n```"} />);

    const code = container.querySelector("code");
    expect(code?.textContent).toBe("solo\n");
    expect(code?.className).toContain("bg-muted");
    expect(screen.queryByText(CODE_BLOCK_LABEL)).not.toBeInTheDocument();
  });

  it("flattens element and array children to text when deciding block vs inline", () => {
    const { container } = render(
      <MarkdownContent
        remarkPlugins={[remarkMixedInlineCode]}
        text="see `x` here"
      />
    );

    // getTextContent walks [<span>first</span>, "\nsecond"] to "first\nsecond";
    // the newline routes the inline code to CodeBlock. Pins current behavior;
    // looks odd because a block <div> lands inside the paragraph <p> (React
    // logs a nesting warning).
    const pre = container.querySelector("pre");
    expect(pre?.textContent).toBe("first\nsecond");
    expect(screen.getByText(CODE_BLOCK_LABEL)).toBeInTheDocument();
  });

  it("applies the dense classes only when dense is set", () => {
    const { container: dense } = render(<MarkdownContent dense text="hi" />);
    expect(dense.firstElementChild?.className).toContain("text-[12px]");
    cleanup();
    const { container: normal } = render(<MarkdownContent text="hi" />);
    expect(normal.firstElementChild?.className).not.toContain("text-[12px]");
  });
});
