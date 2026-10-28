/**
 * The Yjs `XmlFragment` a document's content lives in. It is the default
 * `field` of `@liveblocks/react-tiptap` 3.18.5, so existing content stays where
 * Liveblocks wrote it (PLN-2099 E6). Consumers: the editor's `Collaboration`
 * extension (ISS-12504) and the doc-sync service's seed writers (ISS-12505,
 * ISS-12508). Permanent: a different name reads an empty document.
 */
export const DOCUMENT_FRAGMENT_FIELD = "default" as const;
