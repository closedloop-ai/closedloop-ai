import { LiveblocksSchemaName } from "@repo/document-schema/liveblocks";
import {
  type DocSyncMention,
  DocSyncMentionKind,
  docSyncCallbackIdSchema,
} from "@repo/realtime-contract/doc-sync-internal";
import { XmlElement, type XmlFragment } from "yjs";

/**
 * PLN-2200 T-7.3: the user and group mentions in `fragment`, deduped by kind
 * and id, in document order, at most `max`; `truncated` when more distinct
 * ones exist, or one has an id `docSyncCallbackIdSchema` refuses, which is
 * left out. Only the mention node's `id` attribute is read.
 */
export function currentMentions(
  fragment: XmlFragment,
  max: number
): { mentions: DocSyncMention[]; truncated: boolean } {
  const mentions: DocSyncMention[] = [];
  const seen = new Set<string>();
  const pending = fragment.toArray().reverse();
  let leftOut = false;
  while (pending.length > 0) {
    const node = pending.pop();
    if (!(node instanceof XmlElement)) {
      continue;
    }
    const mention = mentionOf(node);
    if (mention === undefined) {
      pending.push(...node.toArray().reverse());
      continue;
    }
    if (!docSyncCallbackIdSchema.safeParse(mention.id).success) {
      leftOut = true;
      continue;
    }
    const key = `${mention.kind}\u0000${mention.id}`;
    if (seen.has(key)) {
      continue;
    }
    if (mentions.length === max) {
      return { mentions, truncated: true };
    }
    seen.add(key);
    mentions.push(mention);
  }
  return { mentions, truncated: leftOut };
}
const MENTION_KIND_BY_NODE: ReadonlyMap<string, DocSyncMentionKind> = new Map([
  [LiveblocksSchemaName.Mention, DocSyncMentionKind.User],
  [LiveblocksSchemaName.GroupMention, DocSyncMentionKind.Group],
]);

function mentionOf(node: XmlElement): DocSyncMention | undefined {
  const kind = MENTION_KIND_BY_NODE.get(node.nodeName);
  if (kind === undefined) {
    return;
  }
  const id: unknown = node.getAttribute("id");
  return typeof id === "string" && id.length > 0 ? { kind, id } : undefined;
}
