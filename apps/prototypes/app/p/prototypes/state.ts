import type { Annotation } from "./mock";

export function toggleResolvedAnnotation(
  annotations: readonly Annotation[],
  id: number
): Annotation[] {
  return annotations.map((annotation) =>
    annotation.id === id
      ? { ...annotation, resolved: !annotation.resolved }
      : annotation
  );
}

export function getOpenCommentCount(
  annotations: readonly Annotation[]
): number {
  return annotations.filter((annotation) => !annotation.resolved).length;
}
