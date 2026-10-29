import { describe, expect, it } from "vitest";
import { resolveBoardPlacementVersions } from "../use-artifact-placement";

const PROJECT_ID = "00000000-0000-4000-8000-000000000001";
const DESTINATION_ID = "00000000-0000-4000-8000-000000000002";

function getReturning(versions: Record<string, string>) {
  const paths: string[] = [];
  function get<T>(path: string): Promise<T> {
    paths.push(path);
    const projectId = Object.keys(versions).find((id) => path.includes(id));
    return projectId
      ? Promise.resolve({ projectId, projectVersion: versions[projectId] } as T)
      : Promise.reject(new Error("offline"));
  }
  return { get, paths };
}

describe("resolveBoardPlacementVersions", () => {
  it("sends the rendered board version without reading it again", async () => {
    const { get, paths } = getReturning({ [PROJECT_ID]: "current" });

    await expect(
      resolveBoardPlacementVersions(get, [PROJECT_ID], {
        [PROJECT_ID]: "rendered",
      })
    ).resolves.toEqual({ [PROJECT_ID]: "rendered" });
    expect(paths).toEqual([]);
  });

  it("reads the current version when an older API omitted the page version", async () => {
    const { get, paths } = getReturning({ [PROJECT_ID]: "current" });

    await expect(
      resolveBoardPlacementVersions(get, [PROJECT_ID], undefined)
    ).resolves.toEqual({ [PROJECT_ID]: "current" });
    expect(paths).toEqual([`/projects/${PROJECT_ID}/artifacts/placement`]);
  });

  it("leaves out a version it could not read", async () => {
    const { get, paths } = getReturning({ [PROJECT_ID]: "current" });

    await expect(
      resolveBoardPlacementVersions(get, [PROJECT_ID, DESTINATION_ID], {
        [PROJECT_ID]: "rendered",
      })
    ).resolves.toEqual({ [PROJECT_ID]: "rendered" });
    expect(paths).toEqual([`/projects/${DESTINATION_ID}/artifacts/placement`]);
  });
});
