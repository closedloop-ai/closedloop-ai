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

// A raw `<script` in the OUTPUT is the failure that would matter for every
// adversarial case below; the escaped spellings are inert text.
const RAW_SCRIPT_TAG = /<script/i;

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

    it("preserves markdown autolink URLs", () => {
      const content = "See <https://example.com> for details";
      const result = sanitizeDocumentContent(content);
      expect(result.content).toBe(content);
      expect(result.stripped.length).toBe(0);
    });

    it("preserves markdown autolink emails", () => {
      const content = "Contact <foo@example.com> please";
      const result = sanitizeDocumentContent(content);
      expect(result.content).toBe(content);
      expect(result.stripped.length).toBe(0);
    });

    it("preserves angle-bracket placeholders", () => {
      const content = "Use <YOUR_API_KEY> in the request";
      const result = sanitizeDocumentContent(content);
      expect(result.content).toBe(content);
      expect(result.stripped.length).toBe(0);
    });

    it("preserves angle-bracket placeholders (REPLACE_ME pattern)", () => {
      const content = "replace <REPLACE_ME> with real value";
      const result = sanitizeDocumentContent(content);
      expect(result.content).toBe(content);
      expect(result.stripped.length).toBe(0);
    });

    it("preserves bare less-than in prose (x < 5)", () => {
      const content = "If x < 5 and y > 3";
      const result = sanitizeDocumentContent(content);
      expect(result.content).toBe(content);
      expect(result.stripped.length).toBe(0);
    });

    it("preserves bare less-than without closing angle (a<b)", () => {
      const content = "Use a<b for comparison";
      const result = sanitizeDocumentContent(content);
      expect(result.content).toBe(content);
      expect(result.stripped.length).toBe(0);
    });

    it("preserves arrow functions in prose", () => {
      const content = "Pass (x) => x*2";
      const result = sanitizeDocumentContent(content);
      expect(result.content).toBe(content);
      expect(result.stripped.length).toBe(0);
    });

    it("preserves inline code containing HTML tags", () => {
      const content = '`<div class="foo">`';
      const result = sanitizeDocumentContent(content);
      expect(result.content).toBe(content);
      expect(result.stripped.length).toBe(0);
    });

    it("preserves inline code containing TypeScript generics", () => {
      const content = "`Array<T>`";
      const result = sanitizeDocumentContent(content);
      expect(result.content).toBe(content);
      expect(result.stripped.length).toBe(0);
    });

    it("preserves inline code with escaped angle brackets", () => {
      const content = "Avoid `<script>` in user input";
      const result = sanitizeDocumentContent(content);
      expect(result.content).toBe(content);
      expect(result.stripped.length).toBe(0);
    });

    it("preserves JSX/component references in prose", () => {
      const content = "Render <Component /> in your tree";
      const result = sanitizeDocumentContent(content);
      expect(result.content).toBe(content);
      expect(result.stripped.length).toBe(0);
    });

    it("preserves details/summary elements", () => {
      const content = "<details><summary>Click</summary>Hidden</details>";
      const result = sanitizeDocumentContent(content);
      expect(result.content).toBe(content);
      expect(result.stripped.length).toBe(0);
    });

    it("preserves kbd, sub, sup elements", () => {
      const content =
        "<kbd>Ctrl</kbd>+<kbd>C</kbd>, H<sub>2</sub>O, 10<sup>3</sup>";
      const result = sanitizeDocumentContent(content);
      expect(result.content).toBe(content);
      expect(result.stripped.length).toBe(0);
    });

    it("preserves HTML comments", () => {
      const content = "text <!-- a comment --> more text";
      const result = sanitizeDocumentContent(content);
      expect(result.content).toContain("<!-- a comment -->");
      expect(result.stripped.length).toBe(0);
    });

    it("preserves indented code blocks", () => {
      const content =
        "Paragraph before.\n\n    <script>alert(1)</script>\n    more code\n\nParagraph after.";
      const result = sanitizeDocumentContent(content);
      expect(result.content).toContain("<script>alert(1)</script>");
      expect(result.stripped.length).toBe(0);
    });

    it("strips uppercase HTML tags instead of restoring them as placeholders", () => {
      const content = "<SCRIPT>alert(1)</SCRIPT>";
      const result = sanitizeDocumentContent(content);
      expect(result.content).toBe("");
      expect(result.content).not.toContain("<SCRIPT>");
      expect(result.stripped).toContain("<SCRIPT>");
    });

    it("preserves comparison operators without corrupting allowed tag closers", () => {
      const content =
        '<a href="https://example.com" >docs</a>\n\nIf x < 5 and y > 3';
      const result = sanitizeDocumentContent(content);
      expect(result.content).toBe(
        '<a href="https://example.com">docs</a>\n\nIf x < 5 and y > 3'
      );
      expect(result.content).not.toContain("&gt;");
      expect(result.content).not.toContain("__SANITIZE_");
    });

    it("does not leak internal placeholders when preserving mixed markdown constructs", () => {
      const content =
        "Use <YOUR_API_KEY>, `Array<T>`, (x) => x * 2, and <https://example.com> while x < 5 and y > 3";
      const result = sanitizeDocumentContent(content);
      expect(result.content).toBe(content);
      expect(result.content).not.toContain("__SANITIZE_");
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
    it("sanitizes 5000 lines with one or two unclosed backticks each without corrupting them", () => {
      const lines: string[] = [];
      for (let i = 0; i < 2500; i++) {
        lines.push("`single backtick line", "``double backtick line");
      }
      const content = lines.join("\n");

      const result = sanitizeDocumentContent(content);

      // Correctness at scale, not a wall-clock bound. What a timing assertion
      // never proved is that all 5000 unclosed-backtick lines survive the
      // placeholder round-trip byte for byte; the explicit 2 s test timeout
      // below is what catches a backtracking regression, and unlike an
      // `expect(elapsed)` bound it is a budget rather than an assertion, so it
      // is not the load-sensitive thing AGENTS.md bans.
      expect(result.content).toBe(content);
      expect(result.stripped).toEqual([]);
    }, 2000);
  });

  describe("bare ampersand preservation (ISS-9925)", () => {
    // One save cycle plus the SECOND one: a rewrite that is merely wrong is a
    // one-off diff, but a rewrite that re-reads its own output compounds, and
    // only the second pass can tell those apart.
    const saveTwice = (content: string) => {
      const first = sanitizeDocumentContent(content);
      const second = sanitizeDocumentContent(first.content);
      return { first: first.content, second: second.content };
    };

    it.each([
      ["a heading", "## Goals & Success Metrics"],
      ["prose", "The R&D team shipped it."],
      ["a link query string", "[x](https://example.com/s?a=1&b=2)"],
      ["an inline code span", "Write `a && b` to combine them."],
      ["a fenced code block", "```ts\nconst ok = a && b;\n```"],
    ])(
      "leaves a bare & in %s untouched across two saves",
      (_label, content) => {
        const { first, second } = saveTwice(content);
        expect(first).toBe(content);
        expect(second).toBe(content);
      }
    );

    it("leaves an author's deliberate &amp; single-escaped across two saves", () => {
      const content = "Literally &amp; in the source.";
      const { first, second } = saveTwice(content);
      expect(first).toBe(content);
      expect(second).toBe(content);
    });

    it("leaves an author's deliberate &lt; single-escaped across two saves", () => {
      const content = "Escaped &lt;tag&gt; in the source.";
      const { first, second } = saveTwice(content);
      expect(first).toBe(content);
      expect(second).toBe(content);
    });

    // The sibling of the two cases above: those pin that an & already spelling
    // an entity is NOT re-escaped, and this pins that one which is not IS left
    // bare — the same predicate asserted in its opposite state, so a pass that
    // simply stopped protecting anything could not satisfy both.
    it("keeps a bare & bare while an entity-spelling & stays an entity", () => {
      const result = sanitizeDocumentContent(
        "bare & and entity &amp; together"
      );
      expect(result.content).toBe("bare & and entity &amp; together");
    });

    // Prose that is SHAPED like an entity but is not one. The first cut of this
    // pass tested the shape and corrupted all of these, while preserving `R&D`
    // in the same document — one body spelling `&` two ways, which is worse than
    // spelling it wrong consistently because neither form is then safe to repair
    // mechanically.
    it.each([
      ["a bare initialism", "Q&A; see below"],
      ["a finance abbreviation", "P&L; and more"],
      ["a company name", "AT&T; the carrier"],
      ["an unknown named reference", "Ships &foo; and &NotAnEntity; verbatim"],
    ])("preserves %s that only looks like an entity", (_label, content) => {
      const { first, second } = saveTwice(content);
      expect(first).toBe(content);
      expect(second).toBe(content);
    });

    it("leaves a real entity inside an HTML attribute for sanitize-html to escape", () => {
      // A bare `&` in an `href` is not conformant HTML, so the protection must
      // NOT reach inside a tag. Reachable with user-supplied content (document
      // bodies are user- and agent-written) but not an injection: the scheme
      // allow-list has already run, the `&` sits inside a quoted value whose
      // quotes are still escaped, and a character reference cannot open a tag.
      const result = sanitizeDocumentContent(
        '<a href="https://x.com/?a=1&b=2">x</a>'
      );
      expect(result.content).toBe('<a href="https://x.com/?a=1&amp;b=2">x</a>');
    });

    describe("adversarial input", () => {
      // The burden on a loosened sanitizer escape is the hostile input, not the
      // friendly one. Each row asserts the payload is still delivered as inert
      // TEXT and that a second save does not decode it one step further — the
      // failure that would matter is a `<script` the renderer can act on.
      it.each([
        ["an escaped script tag", "&lt;script&gt;alert(1)&lt;/script&gt;"],
        ["a double-encoded payload", "&amp;lt;script&amp;gt;"],
        ["a triple-encoded payload", "&amp;amp;lt;script&amp;amp;gt;"],
        ["an unknown named reference", "&NotAnEntity;"],
      ])("round-trips %s unchanged and inert", (_label, content) => {
        const { first, second } = saveTwice(content);
        expect(first).toBe(content);
        expect(second).toBe(content);
        expect(first).not.toMatch(RAW_SCRIPT_TAG);
      });

      it.each([
        ["a decimal reference", "&#60;script&#62;", "&lt;script&gt;"],
        ["a hex reference", "&#x3C;script&#x3E;", "&lt;script&gt;"],
      ])(
        "normalizes %s to its escaped form rather than decoding it to markup",
        (_label, content, expected) => {
          const { first, second } = saveTwice(content);
          expect(first).toBe(expected);
          expect(second).toBe(expected);
          expect(first).not.toMatch(RAW_SCRIPT_TAG);
        }
      );

      it("strips a real script tag that follows a bare &", () => {
        const result = sanitizeDocumentContent("&<script>alert(1)</script>");
        expect(result.content).toBe("&");
        // Sibling of the content assertion: a regression that removed the tag
        // but stopped populating `stripped` would silence the
        // `document.content.sanitized` audit warning while still looking clean.
        expect(result.stripped.length).toBeGreaterThan(0);
      });

      // whitlockk's review of the first cut: a numeric character reference is
      // decoded WITHOUT its trailing semicolon, so an `&` this pass hid from
      // sanitize-html would clear the scheme allow-list as a relative URL and
      // come back a browser-decoded `javascript:` one. Nothing is hidden here:
      // inside a tag because the pass skips tags, and in prose because asking
      // sanitize-html — which decodes `&#58alert` — reports a reference where
      // the superseded shape test, requiring the `;`, reported none. Either
      // guard alone is sufficient, so the href row falls only when BOTH go and
      // the prose row falls to the shape test on its own.
      it("does not hide a semicolon-less numeric reference from the scheme gate", () => {
        expect(
          sanitizeDocumentContent('<a href="javascript&#58alert(1)">x</a>')
            .content
        ).toBe("<a>x</a>");
        // Unchanged from before this pass existed: sanitize-html decodes the
        // reference in prose, which is what stops it reaching storage in the
        // disguised spelling a link gate would read as inert.
        expect(
          sanitizeDocumentContent("[x](javascript&#58alert(1))").content
        ).toBe("[x](javascript:alert(1))");
      });

      it("keeps a lone & stable beside a tag character on either side", () => {
        for (const content of ["&", "x &", "&<", "<&"]) {
          const { first, second } = saveTwice(content);
          expect(first).toBe(content);
          expect(second).toBe(content);
        }
      });

      // The guard's own miss before this: `ENTITY_REFERENCE_HEAD` required a
      // trailing `;`, so the ~106 HTML5 LEGACY names that decode without one
      // slipped through and `&` + `lt` was restored bare, minting `&ltscript`
      // from a literal `&` and the word `lt` the author wrote separately.
      it("escapes a splice that would mint a semicolon-less legacy entity", () => {
        const { first, second } = saveTwice("&<span>lt</span>script>");
        expect(first).toBe("&amp;ltscript&gt;");
        expect(second).toBe(first);
      });

      // Correctness at scale, in the shape the sibling ReDoS block uses: the
      // explicit timeout is the budget and the assertion is round-trip fidelity,
      // never an elapsed-time bound. Registering each protected `&` in the
      // placeholder map cost the restore loop one full-string scan per
      // ampersand, which this body (≈60k of them) turns from a slow function
      // into a held row lock — `sanitizeAndLog` runs inside the document write
      // transaction.
      it("sanitizes a 1 MB body dense with ampersands without corrupting it", () => {
        const line = "see [x](https://e.com/?a=1&b=2) and R&D plus AT&T.\n";
        const content = line.repeat(20_000);

        const result = sanitizeDocumentContent(content);

        expect(result.content).toBe(content);
        expect(result.stripped).toEqual([]);
        // 1 s is a BUDGET, not an elapsed-time assertion (same shape as the
        // sibling ReDoS case). Measured on this body: ~50 ms correct, ~1800 ms
        // with each protected `&` registered in the placeholder map — so the
        // bound separates them by >15x in one direction and 1.8x in the other,
        // which is what keeps it from flaking on a loaded box.
      }, 1000);
    });

    // Stripping a disallowed tag can butt the protected & straight up against
    // entity-ish text it was never adjacent to. Restoring a plain & there would
    // mint `&#60;` from two things the author did not write together, and the
    // NEXT save would read that as a real entity and rewrite it — so the escape
    // is decided from what actually follows after sanitizing, not up front.
    it("escapes a protected & that tag-stripping would splice into an entity", () => {
      const { first, second } = saveTwice("A &<span>#60;script>");
      expect(first).toBe("A &amp;#60;script&gt;");
      expect(second).toBe(first);
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

  // ISS-10138. Restoring with one `replaceAll` per key was O(keys x body). The
  // single-pass replacement is only correct because its callback re-resolves
  // its own result: an earlier pass's key can sit INSIDE a later pass's captured
  // value, which is what the old reverse-insertion-order loop handled by
  // ordering. Nothing in this suite covered that before — a non-recursive
  // rewrite passed all 77 of the cases above while leaking a raw key into the
  // document.
  describe("nested placeholder restore (ISS-10138)", () => {
    it("restores an inline span captured inside an indented code block", () => {
      const nested = INDENT_AROUND_INLINE_CODE;

      expect(sanitizeDocumentContent(nested).content).toBe(nested);
    });

    it("restores an inline span captured inside an HTML comment", () => {
      const nested = COMMENT_AROUND_INLINE_CODE;

      expect(sanitizeDocumentContent(nested).content).toBe(nested);
    });

    it("does not add a body scan per placeholder", () => {
      // Equal, not merely bounded: the passes are a fixed list, so eleven times
      // the placeholders must buy zero extra scans. The old shape spent one per
      // key, which is 200 more here.
      expect(countFullBodyScans(MANY_SPANS)).toBe(
        countFullBodyScans(FEW_SPANS)
      );
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
// A markdown body whose inline code spans are captured by a LATER pass than the
// one that protects them, which is the only shape that exercises nesting.
const INDENT_AROUND_INLINE_CODE = [
  "intro paragraph",
  "",
  "    indented `inline` line",
  "    second line",
  "",
  "trailing",
  "",
].join("\n");

const COMMENT_AROUND_INLINE_CODE = "before <!-- note `code` here --> after";

const FEW_SPANS = 20;
const MANY_SPANS = 220;

function inlineSpanBody(spans: number): string {
  const lines: string[] = [];
  for (let index = 0; index < spans; index++) {
    lines.push(`paragraph ${index} holding \`token_${index}\` and prose.`, "");
  }
  return lines.join("\n");
}

/**
 * Full-body scans one sanitize costs, counted rather than timed: a wall-clock
 * threshold is what `no-timing-assertions` forbids, and the complexity claim is
 * about scan COUNT anyway.
 *
 * Only calls whose receiver is body-sized are counted. sanitize-html makes its
 * own `replaceAll` calls, one per text node, so an unfiltered count grows with
 * the input for a reason that has nothing to do with the restore.
 */
function countFullBodyScans(spans: number): number {
  const body = inlineSpanBody(spans);
  const bodySized = Math.floor(body.length / 2);
  const actual = String.prototype.replaceAll;
  let scans = 0;
  const spy = vi
    .spyOn(String.prototype, "replaceAll")
    .mockImplementation(function (this: string, ...args: unknown[]): string {
      if (this.length >= bodySized) {
        scans++;
      }
      return Reflect.apply(actual, this, args) as string;
    });

  try {
    sanitizeDocumentContent(body);
  } finally {
    spy.mockRestore();
  }

  return scans;
}
