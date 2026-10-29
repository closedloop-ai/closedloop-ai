import type { ResolvedPos } from "@tiptap/pm/model";
import {
  AllSelection,
  NodeSelection,
  type Selection,
  TextSelection,
} from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

/** Synchronize native text selection before keyboard shortcut plugins consume it. */
export function synchronizeEditorDomSelection(
  view: EditorView,
  event: KeyboardEvent
): false {
  if (!canSynchronizeSelection(view, event)) {
    return false;
  }
  const selection = readNativeTextSelection(view);
  if (selection && !selection.eq(view.state.selection)) {
    view.dispatch(
      view.state.tr.setSelection(selection).setMeta("addToHistory", false)
    );
  }
  return false;
}

function canSynchronizeSelection(
  view: EditorView,
  event: KeyboardEvent
): boolean {
  if (
    event.defaultPrevented ||
    event.isComposing ||
    view.composing ||
    event.altKey ||
    !(event.ctrlKey || event.metaKey) ||
    event.key === "Control" ||
    event.key === "Meta" ||
    event.key === "Shift" ||
    event.key === "Alt" ||
    event.key === "Process" ||
    event.key === "Dead"
  ) {
    return false;
  }
  return (
    view.editable &&
    view.hasFocus() &&
    (view.state.selection instanceof TextSelection ||
      view.state.selection instanceof AllSelection ||
      view.state.selection instanceof NodeSelection)
  );
}

function readNativeTextSelection(view: EditorView): Selection | null {
  const native = view.dom.ownerDocument.getSelection();
  if (
    native?.rangeCount !== 1 ||
    !native.anchorNode ||
    !native.focusNode ||
    !view.dom.contains(native.anchorNode) ||
    !view.dom.contains(native.focusNode)
  ) {
    return null;
  }

  try {
    const anchor = view.posAtDOM(native.anchorNode, native.anchorOffset, 1);
    const head = view.posAtDOM(native.focusNode, native.focusOffset, 1);
    const $anchor = view.state.doc.resolve(anchor);
    const $head = view.state.doc.resolve(head);
    // Root selections retain their existing ProseMirror semantics.
    if (!($anchor.parent.inlineContent && $head.parent.inlineContent)) {
      return null;
    }
    const model = view.state.selection;
    if (
      model instanceof NodeSelection &&
      !canReplaceNodeSelection(
        view,
        model,
        native.anchorNode,
        native.focusNode,
        $anchor,
        $head
      )
    ) {
      return null;
    }
    return (
      view.someProp("createSelectionBetween", (create) =>
        create(view, $anchor, $head)
      ) ?? TextSelection.between($anchor, $head)
    );
  } catch (error) {
    if (error instanceof RangeError) {
      return null;
    }
    throw error;
  }
}

function canReplaceNodeSelection(
  view: EditorView,
  model: NodeSelection,
  anchorNode: Node,
  headNode: Node,
  anchor: ResolvedPos,
  head: ResolvedPos
): boolean {
  const from = Math.min(anchor.pos, head.pos);
  const to = Math.max(anchor.pos, head.pos);
  const node = view.state.doc.nodeAt(from);
  if (
    (from === model.from && to === model.to) ||
    (node?.isAtom && !node.isText && to - from === node.nodeSize)
  ) {
    return false;
  }
  return (
    isNativeDocumentTextPoint(view, anchorNode, anchor) &&
    isNativeDocumentTextPoint(view, headNode, head)
  );
}

function isNativeDocumentTextPoint(
  view: EditorView,
  node: Node,
  position: ResolvedPos
): boolean {
  if (isNativeAtomPoint(view, node, position)) {
    return false;
  }
  const before = view.domAtPos(position.pos, -1);
  const after = view.domAtPos(position.pos, 1);
  // Mark wrappers and trailing BRs can share a text position's DOM representation.
  return node.contains(before.node) || node.contains(after.node);
}

function isNativeAtomPoint(
  view: EditorView,
  nativeNode: Node,
  position: ResolvedPos
): boolean {
  const after = position.nodeAfter;
  if (
    after?.isAtom &&
    !after.isText &&
    view.nodeDOM(position.pos)?.contains(nativeNode)
  ) {
    return true;
  }
  const before = position.nodeBefore;
  return Boolean(
    before?.isAtom &&
      !before.isText &&
      view.nodeDOM(position.pos - before.nodeSize)?.contains(nativeNode)
  );
}
