import { readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertBindMountVisible,
  BIND_MOUNT_PROBE_FILE,
  BindMountNotVisibleError,
  makeVisibleBindSource,
} from "./bind-mount-visibility";

// ISS-10032. A bind mount whose source is outside the VM's shared paths does
// not error — the daemon mounts an EMPTY dir, so the fixture fails later
// wearing an unrelated error's clothes. Both legs are driven here: a source the
// daemon CAN see must stay silent, and one it cannot must refuse. A check that
// refuses everything is as useless as one that refuses nothing.
const IMAGE = "postgres:16";

describe("bind-mount visibility (ISS-10032)", () => {
  const created: string[] = [];

  afterEach(async () => {
    for (const dir of created.splice(0)) {
      await rm(dir, { force: true, recursive: true });
    }
  });

  async function scratch(): Promise<string> {
    const dir = await makeVisibleBindSource("iss10032-");
    created.push(dir);
    return dir;
  }

  it("anchors the bind source under $HOME, not os.tmpdir()", async () => {
    const dir = await scratch();

    expect(dir.startsWith(path.join(homedir(), ".cache") + path.sep)).toBe(
      true
    );
    expect(dir.startsWith(tmpdir())).toBe(false);
  });

  // NEGATIVE CONTROL: the daemon can see the source, so the probe stays silent.
  // The stub reads the real file off disk rather than echoing a canned string,
  // which is also what proves the token was written INTO the bind source.
  it("stays silent when the probe reads this run's token back out of the source", async () => {
    const dir = await scratch();
    const probed: string[] = [];

    await expect(
      assertBindMountVisible({
        hostPath: dir,
        image: IMAGE,
        readProbe: async (hostPath, image) => {
          probed.push(`${image}:${hostPath}`);
          return await readFile(
            path.join(hostPath, BIND_MOUNT_PROBE_FILE),
            "utf-8"
          );
        },
      })
    ).resolves.toBeUndefined();

    expect(probed).toEqual([`${IMAGE}:${dir}`]);
  });

  // POSITIVE CONTROL: the empty-mount signature. `""` is exactly what a source
  // outside the VM's shared paths produces — measured on Dory 29.6.1, where a
  // /var/folders source mounts an empty dir and $HOME/.cache does not.
  it("refuses when the probe comes back empty, naming the empty mount", async () => {
    const dir = await scratch();

    const refusal = assertBindMountVisible({
      hostPath: dir,
      image: IMAGE,
      readProbe: () => Promise.resolve(""),
    });

    await expect(refusal).rejects.toBeInstanceOf(BindMountNotVisibleError);
    await expect(refusal).rejects.toThrow(
      `cannot see the bind-mount source ${dir} `
    );
    await expect(refusal).rejects.toThrow(
      `${BIND_MOUNT_PROBE_FILE} came back empty from inside the container`
    );
    await expect(refusal).rejects.toThrow(`Remedy: share ${path.dirname(dir)}`);
  });

  // The other miss. A stale or wrong source is a DIFFERENT fault on the
  // operator's machine than an unshared one, so the refusal must not call this
  // an empty mount — it must quote what actually came back.
  it("refuses a non-empty read as a stale source, not as an empty mount", async () => {
    const dir = await scratch();
    const foreignToken = "6f1b0c2e-0000-4000-8000-000000000000";

    const refusal = assertBindMountVisible({
      hostPath: dir,
      image: IMAGE,
      readProbe: () => Promise.resolve(`${foreignToken}\n`),
    });

    await expect(refusal).rejects.toBeInstanceOf(BindMountNotVisibleError);
    await expect(refusal).rejects.toThrow(foreignToken);
    await expect(refusal).rejects.toThrow(
      "instead of this run's token, so the daemon mounted a different or stale directory"
    );
    await expect(refusal).rejects.not.toThrow("came back empty");
    await expect(refusal).rejects.toThrow(`Remedy: share ${path.dirname(dir)}`);
  });

  // Bounded so a wrong source holding a large file stays one readable line.
  it("truncates a long foreign read in the refusal", async () => {
    const dir = await scratch();

    const refusal = assertBindMountVisible({
      hostPath: dir,
      image: IMAGE,
      readProbe: () => Promise.resolve("x".repeat(500)),
    });

    await expect(refusal).rejects.toThrow(`"${"x".repeat(80)}"`);
    await expect(refusal).rejects.not.toThrow("x".repeat(81));
  });

  it("propagates a failure of the probe command itself rather than calling it an unshared mount", async () => {
    const dir = await scratch();
    const daemonText =
      "Cannot connect to the Docker daemon at unix:///var/run/docker.sock.";

    const failure = assertBindMountVisible({
      hostPath: dir,
      image: IMAGE,
      readProbe: () => Promise.reject(new Error(daemonText)),
    });

    await expect(failure).rejects.not.toBeInstanceOf(BindMountNotVisibleError);
    await expect(failure).rejects.toThrow(daemonText);
  });
});
