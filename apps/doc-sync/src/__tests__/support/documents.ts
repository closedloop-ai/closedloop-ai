import { DOCUMENT_FRAGMENT_FIELD } from "@repo/document-schema/collaboration-field";
import { Doc, encodeStateAsUpdate, XmlElement, XmlText } from "yjs";

/** Appends one paragraph holding `text` to `doc`'s document fragment. */
export function appendParagraph(doc: Doc, text: string): void {
  const fragment = doc.getXmlFragment(DOCUMENT_FRAGMENT_FIELD);
  doc.transact(() => {
    const paragraph = new XmlElement("paragraph");
    const node = new XmlText();
    node.insert(0, text);
    paragraph.insert(0, [node]);
    fragment.insert(fragment.length, [paragraph]);
  });
}

/** A stored document state with one paragraph per entry of `paragraphs`. */
export function documentState(...paragraphs: string[]): Uint8Array {
  const doc = new Doc();
  for (const text of paragraphs) {
    appendParagraph(doc, text);
  }
  const state = encodeStateAsUpdate(doc);
  doc.destroy();
  return state;
}
