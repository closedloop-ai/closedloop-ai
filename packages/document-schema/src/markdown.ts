/// <reference path="./jsdom.d.ts" />
import { Editor, type JSONContent } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { JSDOM } from "jsdom";
import {
  getDefaults,
  Hooks,
  Lexer,
  Marked,
  type MarkedOptions,
  type marked,
  Parser,
  Renderer,
  TextRenderer,
  Tokenizer,
} from "marked";
import { createDocumentExtensions } from "./extensions";
import { liveblocksSchemaExtensions } from "./liveblocks";

const EMPTY_DOCUMENT = { type: "doc", content: [{ type: "paragraph" }] };

let serverDomParser: ServerDomParser | undefined;

/**
 * Parses markdown into the document the editor produces from the same input,
 * with every `appendTransaction` normalization (the mermaid transform,
 * StarterKit's `TrailingNode`, prosemirror-tables' `fixTables`) applied as in
 * the browser.
 */
export function markdownToDocument(markdown: string): ProseMirrorNode {
  const editor = new Editor({
    extensions: [
      ...createDocumentExtensions({
        undoRedo: false,
        // `@tiptap/markdown` adds a tokenizer per extension to its `marked` on
        // every editor and never removes it, so each call on the shared
        // singleton would grow it for the life of the process.
        marked: createIsolatedMarked(),
      }),
      ...liveblocksSchemaExtensions,
    ],
    // JSON, because string content needs `window`.
    content: EMPTY_DOCUMENT,
  });
  try {
    const manager = editor.markdown;
    if (!manager) {
      throw new Error("document extensions registered no markdown manager");
    }
    // A headless editor starts with no ProseMirror plugins, so `setContent`
    // would skip every `appendTransaction` normalization.
    editor.view.updateState(
      editor.state.reconfigure({ plugins: editor.extensionManager.plugins })
    );
    editor.commands.setContent(withDomParser(() => manager.parse(markdown)));
    return editor.state.doc;
  } finally {
    editor.destroy();
  }
}

/**
 * `@tiptap/markdown` reads HTML in markdown (the `<br>` a table cell's line
 * break is saved as, a legacy `<img src="attachment://…">`) through
 * `window.DOMParser`, and keeps it as literal text when there is no window.
 * Under Node, a jsdom-backed `DOMParser` stands in for the length of the parse.
 */
function withDomParser(parse: () => JSONContent): JSONContent {
  if ("window" in globalThis) {
    return parse();
  }
  serverDomParser ??= createServerDomParser();
  Reflect.set(globalThis, "window", { DOMParser: serverDomParser });
  try {
    return parse();
  } finally {
    Reflect.deleteProperty(globalThis, "window");
  }
}
/**
 * A `marked` over its own `Marked` instance, shaped like the module's
 * `marked` export (which `@tiptap/markdown` types its option as), so options
 * and extensions set on it never reach the process-wide defaults.
 */
function createIsolatedMarked(): typeof marked {
  const instance = new Marked();
  function isolated(
    src: string,
    options: MarkedOptions & { async: true }
  ): Promise<string>;
  function isolated(
    src: string,
    options: MarkedOptions & { async: false }
  ): string;
  function isolated(
    src: string,
    options?: MarkedOptions | null
  ): string | Promise<string>;
  function isolated(src: string, options?: MarkedOptions | null) {
    return instance.parse(src, options);
  }
  isolated.options = isolated.setOptions = (options: MarkedOptions) => {
    instance.setOptions(options);
    isolated.defaults = instance.defaults;
    return isolated;
  };
  isolated.getDefaults = getDefaults;
  isolated.defaults = instance.defaults;
  isolated.use = (...extensions: Parameters<typeof instance.use>) => {
    instance.use(...extensions);
    isolated.defaults = instance.defaults;
    return isolated;
  };
  isolated.walkTokens = instance.walkTokens.bind(instance);
  isolated.parseInline = instance.parseInline;
  isolated.Parser = Parser;
  isolated.parser = Parser.parse;
  isolated.Renderer = Renderer;
  isolated.TextRenderer = TextRenderer;
  isolated.Lexer = Lexer;
  // `@tiptap/markdown` lexes nested content with no options, so the fallback
  // must be this instance's defaults (its tokenizers), not the module's.
  isolated.lexer = <ParserOutput = string, RendererOutput = string>(
    src: string,
    options?: MarkedOptions<ParserOutput, RendererOutput>
  ) => (options ? Lexer.lex(src, options) : instance.lexer(src));
  isolated.Tokenizer = Tokenizer;
  isolated.Hooks = Hooks;
  isolated.parse = isolated;
  return isolated;
}

type ServerDomParser = new () => {
  parseFromString(html: string, type: string): { body: HTMLElement };
};

/**
 * Parses into one long-lived jsdom document instead of a new one per call.
 * jsdom builds a selector engine per document on its first `matches()`, which
 * ProseMirror's DOM parser calls for every element, so a fresh document per
 * HTML snippet cost about 2 ms each. Tiptap reads only `.body` of the result.
 */
function createServerDomParser(): ServerDomParser {
  const { document } = new JSDOM("").window;
  return class {
    parseFromString(html: string) {
      const body = document.createElement("body");
      body.innerHTML = html;
      return { body };
    }
  };
}
