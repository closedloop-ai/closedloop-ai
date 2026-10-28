/// <reference path="../../jsdom.d.ts" />
import { getSchema } from "@tiptap/core";
import {
  DOMSerializer,
  DOMParser as ProseMirrorDOMParser,
  type Node as ProseMirrorNode,
} from "@tiptap/pm/model";
import { JSDOM } from "jsdom";
import { createDocumentExtensions } from "../../extensions";
import { liveblocksSchemaExtensions } from "../../liveblocks";

const htmlDocument = new new JSDOM("").window.DOMParser().parseFromString(
  "",
  "text/html"
);

export const documentSchema = getSchema([
  ...createDocumentExtensions({ undoRedo: false }),
  ...liveblocksSchemaExtensions,
]);

export function parseHtml(html: string): ProseMirrorNode {
  return ProseMirrorDOMParser.fromSchema(documentSchema).parse(
    htmlElement(`<div>${html}</div>`)
  );
}

export function htmlElement(html: string): HTMLElement {
  const container = htmlDocument.createElement("template");
  container.innerHTML = html;
  const element = container.content.firstElementChild;
  if (!isHtmlElement(element)) {
    throw new Error(`no element in ${html}`);
  }
  return element;
}

export function serializeHtml(doc: ProseMirrorNode): string {
  const container = htmlDocument.createElement("div");
  container.append(
    DOMSerializer.fromSchema(documentSchema).serializeFragment(doc.content, {
      document: htmlDocument,
    })
  );
  return container.innerHTML;
}

function isHtmlElement(element: Element | null): element is HTMLElement {
  return element !== null && "dataset" in element;
}
