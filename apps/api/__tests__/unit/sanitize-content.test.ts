import type { IOptions } from "sanitize-html";
import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/observability/log", () => ({
  log: { warn: vi.fn(), error: vi.fn() },
}));

// Hoist the mock control variable so it can be reset per test.
// The mock factory wraps the real sanitize-html by default, and tests can inject
// a one-shot throwing implementation via `mockSanitizeHtmlOnce`.
let mockSanitizeHtmlOnce: (() => never) | null = null;

vi.mock("sanitize-html", async (importOriginal) => {
  const actual = await importOriginal<{
    default: (html: string, opts: IOptions) => string;
  }>();
  const sanitizeHtmlFn = actual.default;
  return {
    default: (html: string, opts: IOptions) => {
      if (mockSanitizeHtmlOnce) {
        const thrower = mockSanitizeHtmlOnce;
        mockSanitizeHtmlOnce = null;
        thrower();
      }
      return sanitizeHtmlFn(html, opts);
    },
  };
});

import {
  sanitizeAndLog,
  sanitizeDocumentContent,
} from "@/app/documents/sanitize-content";

describe("sanitizeDocumentContent", () => {
  describe("dangerous element stripping", () => {
    it("strips script tags", () => {
      const result = sanitizeDocumentContent(
        "<script>alert('xss')</script>safe text"
      );
      expect(result.content).not.toContain("<script>");
      expect(result.stripped.length).toBeGreaterThan(0);
    });

    it("strips iframe tags", () => {
      const result = sanitizeDocumentContent(
        '<iframe src="https://evil.com"></iframe>text'
      );
      expect(result.content).not.toContain("<iframe");
      expect(result.stripped.length).toBeGreaterThan(0);
    });

    it("strips object tags", () => {
      const result = sanitizeDocumentContent(
        '<object data="file.swf"></object>text'
      );
      expect(result.content).not.toContain("<object");
      expect(result.stripped.length).toBeGreaterThan(0);
    });

    it("strips embed tags", () => {
      const result = sanitizeDocumentContent('<embed src="file.swf">text');
      expect(result.content).not.toContain("<embed");
      expect(result.stripped.length).toBeGreaterThan(0);
    });

    it("strips form tags", () => {
      const result = sanitizeDocumentContent(
        '<form action="/submit"><input type="text"></form>text'
      );
      expect(result.content).not.toContain("<form");
      expect(result.stripped.length).toBeGreaterThan(0);
    });

    it("strips on* event handlers from allowed tags", () => {
      const result = sanitizeDocumentContent('<p onclick="alert(1)">text</p>');
      expect(result.content).not.toContain("onclick");
    });

    it("strips javascript: href", () => {
      const result = sanitizeDocumentContent(
        '<a href="javascript:alert(1)">click</a>'
      );
      expect(result.content).not.toContain("javascript:");
    });

    it("strips data: src from images", () => {
      const result = sanitizeDocumentContent(
        '<img src="data:image/png;base64,abc123">'
      );
      expect(result.content).not.toContain("data:");
    });
  });

  describe("markdown preservation", () => {
    it("preserves headings", () => {
      const content = "# Heading 1\n## Heading 2\n### Heading 3";
      const result = sanitizeDocumentContent(content);
      expect(result.content).toBe(content);
      expect(result.stripped.length).toBe(0);
    });

    it("preserves unordered and ordered lists", () => {
      const content = "- item one\n- item two\n1. first\n2. second";
      const result = sanitizeDocumentContent(content);
      expect(result.content).toBe(content);
      expect(result.stripped.length).toBe(0);
    });

    it("preserves fenced code blocks", () => {
      const content = "```typescript\nconst x = 1;\n```";
      const result = sanitizeDocumentContent(content);
      expect(result.content).toBe(content);
      expect(result.stripped.length).toBe(0);
    });

    it("preserves inline code", () => {
      const content = "Use `const x = 1` here.";
      const result = sanitizeDocumentContent(content);
      expect(result.content).toBe(content);
      expect(result.stripped.length).toBe(0);
    });

    it("preserves https links", () => {
      const content = "See [docs](https://example.com) for details.";
      const result = sanitizeDocumentContent(content);
      expect(result.content).toBe(content);
      expect(result.stripped.length).toBe(0);
    });

    it("preserves https images", () => {
      const content = "![alt text](https://example.com/image.png)";
      const result = sanitizeDocumentContent(content);
      expect(result.content).toBe(content);
      expect(result.stripped.length).toBe(0);
    });

    it("preserves bold and italic", () => {
      const content = "**bold** and _italic_ and *also italic*";
      const result = sanitizeDocumentContent(content);
      expect(result.content).toBe(content);
      expect(result.stripped.length).toBe(0);
    });

    it("preserves strikethrough", () => {
      const content = "~~strikethrough text~~";
      const result = sanitizeDocumentContent(content);
      expect(result.content).toBe(content);
      expect(result.stripped.length).toBe(0);
    });

    it("preserves tables", () => {
      const content = "| col1 | col2 |\n|------|------|\n| a    | b    |";
      const result = sanitizeDocumentContent(content);
      expect(result.content).toBe(content);
      expect(result.stripped.length).toBe(0);
    });

    it("preserves blockquotes exactly", () => {
      const content = "> This is a blockquote\n> spanning two lines";
      const result = sanitizeDocumentContent(content);
      expect(result.content).toBe(content);
      expect(result.stripped.length).toBe(0);
    });
  });

  describe("code block protection", () => {
    it("preserves script text inside triple-backtick code block", () => {
      const content =
        "Some text\n```html\n<script>alert('xss')</script>\n```\nMore text";
      const result = sanitizeDocumentContent(content);
      expect(result.content).toContain("<script>alert('xss')</script>");
    });

    it("preserves mermaid code blocks intact", () => {
      const content = "```mermaid\ngraph TD\n  A --> B\n```";
      const result = sanitizeDocumentContent(content);
      expect(result.content).toBe(content);
      expect(result.stripped.length).toBe(0);
    });

    it("preserves replacement tokens inside fenced code blocks", () => {
      const content = "```js\nconst tokens = '$& $$ $` $\\'';\n```";
      const result = sanitizeDocumentContent(content);
      expect(result.content).toBe(content);
      expect(result.stripped.length).toBe(0);
    });

    it("does not strip tags from code block in blockquote (stripped.length === 0)", () => {
      // The code block placeholder mechanism protects the inner content regardless
      // of the surrounding blockquote syntax.
      const content =
        "> Here is a quote\n> ```js\n> const evil = '<script>';\n> ```";
      const result = sanitizeDocumentContent(content);
      expect(result.stripped.length).toBe(0);
    });
  });

  describe("return value correctness", () => {
    it("stripped array is non-empty when content was modified", () => {
      const result = sanitizeDocumentContent(
        "<script>bad()</script>clean content"
      );
      expect(result.stripped.length).toBeGreaterThan(0);
    });

    it("stripped array is empty when input is already clean", () => {
      const result = sanitizeDocumentContent(
        "# Clean markdown\n\nNo HTML here."
      );
      expect(result.stripped.length).toBe(0);
    });

    it("reports attribute-only sanitization in stripped", () => {
      const result = sanitizeDocumentContent('<p onclick="alert(1)">text</p>');
      expect(result.content).toBe("<p>text</p>");
      expect(result.stripped).toContain('<p onclick="alert(1)">');
    });
  });

  describe("falsy content handling", () => {
    it("returns { content: null, stripped: [] } for null input", () => {
      const result = sanitizeDocumentContent(null);
      expect(result).toEqual({ content: null, stripped: [] });
    });

    it("returns { content: '', stripped: [] } for empty string input", () => {
      const result = sanitizeDocumentContent("");
      expect(result).toEqual({ content: "", stripped: [] });
    });
  });

  describe("adversarial ReDoS", () => {
    it("completes within 500ms for 5000 lines with one or two backticks each", () => {
      const lines: string[] = [];
      for (let i = 0; i < 2500; i++) {
        lines.push("`single backtick line");
        lines.push("``double backtick line");
      }
      const content = lines.join("\n");

      const start = Date.now();
      sanitizeDocumentContent(content);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(500);
    });
  });

  describe("idempotency", () => {
    it("applying sanitize twice yields the same result as applying once", () => {
      const mixedInput =
        "# Title\n\n<script>alert(1)</script>\n\nSafe paragraph with [link](https://example.com).\n\n```js\nconst x = '<div>';\n```";
      const firstPass = sanitizeDocumentContent(mixedInput);
      const secondPass = sanitizeDocumentContent(firstPass.content!);
      expect(secondPass.content).toBe(firstPass.content);
    });
  });

  describe("performance", () => {
    it("sanitizes a 50KB prose-heavy document under 50ms in CI", () => {
      // Production hardware target: <10ms per AC-006; 50ms threshold is generous for GitHub Actions CPU variance.
      const doc = buildProseDocument(51_200);
      const start = Date.now();
      sanitizeDocumentContent(doc);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(50);
    });

    it("sanitizes a 50KB document with 30+ code blocks under 50ms in CI", () => {
      // Production hardware target: <10ms per AC-006; 50ms threshold is generous for GitHub Actions CPU variance.
      const doc = buildCodeBlockDocument(51_200, 32);
      const start = Date.now();
      sanitizeDocumentContent(doc);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(50);
    });
  });
});

describe("sanitizeAndLog", () => {
  describe("fail-open error handling", () => {
    it("returns original content unchanged when sanitize-html throws", () => {
      mockSanitizeHtmlOnce = () => {
        throw new Error("sanitize-html exploded");
      };

      const original = "Some <content> here";
      const result = sanitizeAndLog(original, "doc-123");

      expect(result).toBe(original);
    });

    it("does not throw when sanitize-html throws", () => {
      mockSanitizeHtmlOnce = () => {
        throw new Error("sanitize-html exploded");
      };

      expect(() => sanitizeAndLog("content", "doc-456")).not.toThrow();
    });

    it("returns the original content unchanged when fail-open is triggered", () => {
      mockSanitizeHtmlOnce = () => {
        throw new Error("boom");
      };

      expect(sanitizeAndLog("content", "doc-789")).toBe("content");
    });
  });

  describe("warn log when content is modified", () => {
    it("returns sanitized content when dangerous content is stripped", () => {
      expect(sanitizeAndLog("<script>bad()</script>clean", "doc-warn-1")).toBe(
        "clean"
      );
    });
  });

  describe("no log when nothing is stripped", () => {
    it("returns clean markdown content unchanged", () => {
      expect(
        sanitizeAndLog("# Clean heading\n\nSome **bold** text.", "doc-clean-1")
      ).toBe("# Clean heading\n\nSome **bold** text.");
    });
  });
});

function buildProseDocument(targetBytes: number): string {
  const headings = [
    "# Introduction",
    "## Background",
    "### Details",
    "#### Notes",
    "##### Summary",
  ];
  const paragraphs = [
    "This is a sample paragraph with some **bold** text and _italic_ text for variety.",
    "Another paragraph that contains a [link](https://example.com) and more content to pad the document.",
    "A third paragraph with ~~strikethrough~~ and more words to fill up the required byte count.",
    "Yet another paragraph discussing various topics without any code blocks or dangerous HTML content.",
  ];
  const listItems = [
    "- First item in the list",
    "- Second item with **emphasis**",
    "- Third item with a [link](https://example.com/page)",
    "1. Ordered first item",
    "2. Ordered second item",
    "3. Ordered third item",
  ];
  const blockquotes = [
    "> This is a blockquote with some important information.",
    "> Another blockquote spanning\n> multiple lines of content.",
  ];

  const chunks = [...headings, ...paragraphs, ...listItems, ...blockquotes];

  let doc = "";
  let chunkIndex = 0;
  while (doc.length < targetBytes) {
    doc += `${chunks[chunkIndex % chunks.length]}\n\n`;
    chunkIndex++;
  }
  return doc;
}

function buildCodeBlockDocument(
  targetBytes: number,
  blockCount: number
): string {
  const codeBlock =
    "```javascript\nconst result = someFunction(input);\nconsole.log(result);\nreturn result;\n```";
  const proseParagraph =
    "This is prose padding between code blocks with **bold** and _italic_ text and a [link](https://example.com).";

  const chunks: string[] = [];
  for (let i = 0; i < blockCount; i++) {
    chunks.push(`${proseParagraph}\n\n`);
    chunks.push(`${codeBlock}\n\n`);
  }

  const baseDoc = chunks.join("");
  if (baseDoc.length >= targetBytes) {
    return baseDoc;
  }

  let doc = baseDoc;
  let extraIndex = 0;
  const extraProse = [
    "Additional prose paragraph to reach the target byte count for this performance test.",
    "More filler content with **bold**, _italic_, and ~~strikethrough~~ text elements.",
    "> A blockquote used as padding to grow the document to the required size.",
  ];
  while (doc.length < targetBytes) {
    doc += `${extraProse[extraIndex % extraProse.length]}\n\n`;
    extraIndex++;
  }
  return doc;
}
