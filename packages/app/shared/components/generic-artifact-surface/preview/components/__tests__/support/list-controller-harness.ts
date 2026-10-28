import { renderHook } from "@testing-library/react";
import { useCallback, useState } from "react";
import type { Mock } from "vitest";
import { type GenericArtifact, genericArtifacts } from "../../../fixtures";
import type { GenericArtifactListShellProps } from "../../artifact-list-model";
import { useGenericArtifactListController } from "../../artifact-list-shell-controller";

const template = genericArtifacts[0]!;

/**
 * A root row updated just now, so the shell's default 30-day range keeps it,
 * with its id upper-cased as the slug and used as the title.
 */
export function listRow(
  id: string,
  overrides: Partial<GenericArtifact> = {}
): GenericArtifact {
  return {
    ...template,
    creationValues: undefined,
    id,
    parentArtifactId: null,
    slug: id.toUpperCase(),
    title: id,
    updatedAgoMinutes: 0,
    ...overrides,
  };
}

/** Mounts the list controller hook with rerenderable props. */
export function renderListController(props: GenericArtifactListShellProps) {
  return renderHook(
    (current: GenericArtifactListShellProps) =>
      useGenericArtifactListController(current),
    { initialProps: props }
  );
}

/** Mounts the controller behind the authoritative host state manual ordering requires. */
export function renderControlledListController(
  props: GenericArtifactListShellProps
) {
  return renderHook(() => {
    const [artifacts, setArtifacts] = useState([...props.artifacts]);
    const onArtifactsChange = useCallback(
      (nextArtifacts: readonly GenericArtifact[]) =>
        setArtifacts([...nextArtifacts]),
      []
    );
    return useGenericArtifactListController({
      ...props,
      artifacts,
      controlledArtifacts: true,
      onArtifactsChange,
    });
  });
}

/** Ids of the controller's rows, in stored order. */
export function artifactIds(
  artifacts: readonly GenericArtifact[]
): readonly string[] {
  return artifacts.map((artifact) => artifact.id);
}

/** The most recent success toast raised through the mocked `toast.success`. */
export function lastToast(toastSuccess: Mock): {
  actionLabel: string | undefined;
  description: string | undefined;
  message: string;
  undo: (() => void) | undefined;
} {
  const call = toastSuccess.mock.calls.at(-1);
  return {
    actionLabel: call?.[1]?.action?.label,
    description: call?.[1]?.description,
    message: call?.[0],
    undo: call?.[1]?.action?.onClick,
  };
}
