import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_VERIFICATION_ENDPOINTS } from "../collector-verification/otelcol-config";
import {
  assertBindMountVisible,
  BindMountNotVisibleError,
  runVerification,
} from "../collector-verification/run-verification";

// ISS-9883: the bind-mount source followed the caller's cwd, so a run from a
// /private/tmp worktree mounted a dir a VM-backed daemon (Dory) cannot see and
// otelcol died with "cannot resolve the configuration". These cases drive the
// real `runVerification` against a scripted `docker` — each case names the
// subcommand that fails and the daemon's text — and read the decision off the
// argv. No live daemon is involved.
const docker = vi.hoisted(() => ({
  calls: [] as string[][],
  failures: {} as Record<string, string>,
  /** Set for a runtime that answers `cp` from the image layer, not the mount. */
  imageLayerBody: undefined as string | undefined,
  /** What `docker port` prints per "<port>/tcp"; absent means no mapping. */
  portStdout: {} as Record<string, string>,
}));

vi.mock("node:child_process", () => ({
  execFile: (_file: string, args: string[], ...rest: unknown[]) => {
    const callback = rest.at(-1);
    if (typeof callback !== "function") {
      throw new Error("execFile called without a callback");
    }
    docker.calls.push(args);
    const failure = docker.failures[args[0] ?? ""];
    if (failure !== undefined) {
      callback(new Error(failure));
      return;
    }
    if (args[0] === "cp") {
      // A daemon that applied the bind streams back the host file; one serving
      // the image layer streams whatever the image shipped at that path.
      callback(null, { stdout: cpTarStream(args[1] ?? ""), stderr: "" });
      return;
    }
    if (args[0] === "port") {
      callback(null, {
        stdout: docker.portStdout[args[2] ?? ""] ?? "",
        stderr: "",
      });
      return;
    }
    callback(null, { stdout: "", stderr: "" });
  },
}));

const PROBE_PATH = "/etc/otelcol-contrib/bind-mount-probe";
const IMAGE_STOCK_CONFIG = "receivers:\n  otlp:\n# shipped in the image\n";
const CP_MISSING_PROBE = `Error response from daemon: Could not find the file ${PROBE_PATH} in container probe`;
const MOUNTS_DENIED =
  "Error response from daemon: Mounts denied: \nThe path /private/tmp/x is not shared from the host and is not known to Docker.\nYou can configure shared paths from Docker -> Preferences... -> Resources -> File Sharing.";
const UNSHARED_MOUNT = "cannot see the bind-mount source";

// `docker cp <container>:<path> -` streams an uncompressed tar; the probe only
// looks for its token inside it, so a header-ish prefix around the body is
// enough here. The body comes from the real bind source unless the case asks
// for the image layer, which is what makes the token assertion non-tautological.
function cpTarStream(source: string): string {
  const containerPath = source.slice(source.indexOf(":") + 1);
  const body =
    docker.imageLayerBody ??
    readFileSync(join(mountedSource(), basename(containerPath)), "utf-8");
  return `${basename(containerPath)}\u0000tar-header\u0000${body}\u0000`;
}

/** The host dir the `create` call bound at the collector's config dir. */
function mountedSource(): string {
  const create = docker.calls.find((args) => args[0] === "create") ?? [];
  const mount = create.find((arg) => arg.endsWith(CONFIG_MOUNT_SUFFIX)) ?? "";
  return mount.slice(0, -CONFIG_MOUNT_SUFFIX.length);
}

const PRIVATE_TMP = existsSync("/private/tmp") ? "/private/tmp" : tmpdir();
const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const CONFIG_MOUNT_SUFFIX = ":/etc/otelcol-contrib:ro";

describe("collector verification bind-mount source (ISS-9883)", () => {
  const originalCwd = process.cwd();
  const scratchDirs: string[] = [];

  beforeEach(() => {
    docker.calls.length = 0;
    docker.failures = { cp: CP_MISSING_PROBE };
    docker.imageLayerBody = undefined;
    docker.portStdout = {};
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.chdir(originalCwd);
    for (const dir of scratchDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function privateTmpCwd(): string {
    const dir = mkdtempSync(join(PRIVATE_TMP, "iss9883-cwd-"));
    scratchDirs.push(dir);
    return dir;
  }

  it.each([
    ["inside the repo", () => PACKAGE_DIR],
    ["under /private/tmp", privateTmpCwd],
    ["outside the repo", () => homedir()],
  ])(
    "mounts a dir under ~/.cache and refuses before starting the collector when cwd is %s",
    async (_label, cwdFor) => {
      process.chdir(cwdFor());

      const refusal = runVerification({
        counts: { errors: 1, serverErrors: 1, slow: 1, baseline: 1 },
      });
      await expect(refusal).rejects.toBeInstanceOf(BindMountNotVisibleError);

      const create = docker.calls.find((args) => args[0] === "create") ?? [];
      const configMount = create.find((arg) =>
        arg.endsWith(CONFIG_MOUNT_SUFFIX)
      );
      const bindSource = configMount?.slice(0, -CONFIG_MOUNT_SUFFIX.length);
      expect(bindSource?.startsWith(join(homedir(), ".cache") + sep)).toBe(
        true
      );

      await expect(refusal).rejects.toThrow(
        `cannot see the bind-mount source ${bindSource} `
      );
      await expect(refusal).rejects.toThrow(`${PROBE_PATH} is missing inside`);
      await expect(refusal).rejects.toThrow("Remedy: share ");
      await expect(refusal).rejects.toThrow("Could not find the file");
      expect(docker.calls.map((args) => args[0])).toEqual([
        "pull",
        "create",
        "cp",
        "rm",
      ]);
      // The probe reads the per-run token file, never the config the image
      // also ships at that path.
      expect(docker.calls.find((args) => args[0] === "cp")?.[1]).toMatch(
        new RegExp(`:${PROBE_PATH}$`)
      );
    }
  );

  it("probes the mounted file through the named container and passes when the copy carries this run's token", async () => {
    const sources: string[] = [];
    await assertBindMountVisible({
      containerName: "probe",
      hostPath: join(PRIVATE_TMP, "scratch"),
      containerPath: PROBE_PATH,
      token: "token-abc",
      dockerCp: (source) => {
        sources.push(source);
        return Promise.resolve("tar-header\u0000token-abc\u0000");
      },
    });
    expect(sources).toEqual([`probe:${PROBE_PATH}`]);
  });

  it.each([
    ["the config the image ships at that path", IMAGE_STOCK_CONFIG],
    ["another run's token", "tar-header\u0000token-xyz\u0000"],
    ["an empty copy", ""],
  ])(
    "refuses when the copy carries %s instead of this run's token",
    async (_label, streamed) => {
      const probe = assertBindMountVisible({
        containerName: "probe",
        hostPath: join(PRIVATE_TMP, "scratch"),
        containerPath: PROBE_PATH,
        token: "token-abc",
        dockerCp: () => Promise.resolve(streamed),
      });
      await expect(probe).rejects.toBeInstanceOf(BindMountNotVisibleError);
      await expect(probe).rejects.toThrow("without this run's probe token");
      await expect(probe).rejects.toThrow("Remedy: share ");
      await expect(probe).rejects.not.toThrow("docker said:");
    }
  );

  it("refuses when a runtime answers the probe from the image layer", async () => {
    docker.failures = {};
    docker.imageLayerBody = IMAGE_STOCK_CONFIG;

    const refusal = runVerification({
      counts: { errors: 1, serverErrors: 1, slow: 1, baseline: 1 },
    });
    await expect(refusal).rejects.toBeInstanceOf(BindMountNotVisibleError);
    await expect(refusal).rejects.toThrow("without this run's probe token");
    expect(docker.calls.map((args) => args[0])).toEqual([
      "pull",
      "create",
      "cp",
      "rm",
    ]);
  });

  it("writes the token into the bind source and starts the collector once the copy returns it", async () => {
    docker.failures = {};

    const run = runVerification({
      counts: { errors: 1, serverErrors: 1, slow: 1, baseline: 1 },
    });
    // The stub streams back the real file from the mounted dir, so reaching
    // `start` proves the token was written there and matched on the way out.
    await expect(run).rejects.not.toBeInstanceOf(BindMountNotVisibleError);
    expect(docker.calls.map((args) => args[0])).toContain("start");
  });

  it("retries readiness on the mapped metrics port, then posts the first payload to the mapped OTLP port and stops when the collector rejects it", async () => {
    docker.failures = {};
    docker.portStdout = {
      [`${DEFAULT_VERIFICATION_ENDPOINTS.otlpHttpPort}/tcp`]:
        "127.0.0.1:49153\n",
      [`${DEFAULT_VERIFICATION_ENDPOINTS.metricsPort}/tcp`]:
        "127.0.0.1:49154\n",
    };
    const requests: { url: string; method: string; contentType?: string }[] =
      [];
    let readinessProbes = 0;
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      // The first readiness probe finds the collector still booting.
      const bootingStatus = readinessProbes++ === 0 ? 503 : 200;
      requests.push({
        url,
        method,
        contentType:
          new Headers(init?.headers).get("content-type") ?? undefined,
      });
      return Promise.resolve(
        new Response("", { status: method === "POST" ? 500 : bootingStatus })
      );
    });

    const run = runVerification({
      counts: { errors: 1, serverErrors: 1, slow: 1, baseline: 1 },
    });

    await expect(run).rejects.toThrow("OTLP export rejected: status 500");
    expect(requests).toEqual([
      { url: "http://127.0.0.1:49154/metrics", method: "GET" },
      { url: "http://127.0.0.1:49154/metrics", method: "GET" },
      {
        url: "http://127.0.0.1:49153/v1/traces",
        method: "POST",
        contentType: "application/json",
      },
    ]);
    // A started collector's logs are captured before the container is removed.
    expect(docker.calls.map((args) => args[0])).toEqual([
      "pull",
      "create",
      "cp",
      "start",
      "port",
      "port",
      "logs",
      "rm",
    ]);
    expect(docker.calls.find((args) => args[0] === "port")).toEqual([
      "port",
      `tail-sampling-verify-${process.pid}`,
      `${DEFAULT_VERIFICATION_ENDPOINTS.otlpHttpPort}/tcp`,
    ]);
  });

  it("stops with Docker's stdout when docker port prints no addr:port line, after capturing the started collector's logs", async () => {
    docker.failures = {};
    docker.portStdout = {
      [`${DEFAULT_VERIFICATION_ENDPOINTS.otlpHttpPort}/tcp`]:
        "no public port\n",
    };

    const run = runVerification({
      counts: { errors: 1, serverErrors: 1, slow: 1, baseline: 1 },
    });

    await expect(run).rejects.toThrow(
      `could not resolve host port for container port ${DEFAULT_VERIFICATION_ENDPOINTS.otlpHttpPort}: no public port`
    );
    expect(docker.calls.map((args) => args[0])).toEqual([
      "pull",
      "create",
      "cp",
      "start",
      "port",
      "logs",
      "rm",
    ]);
  });

  it("reports a probe failure that is not an Error by its string form", async () => {
    const probe = assertBindMountVisible({
      containerName: "probe",
      hostPath: join(PRIVATE_TMP, "scratch"),
      containerPath: PROBE_PATH,
      token: "token-abc",
      dockerCp: () => Promise.reject("daemon hung up"),
    });
    await expect(probe).rejects.not.toBeInstanceOf(BindMountNotVisibleError);
    await expect(probe).rejects.toThrow(
      `bind-mount probe \`docker cp probe:${PROBE_PATH} -\` failed: daemon hung up`
    );
  });

  it.each([
    [
      "a daemon that cannot be reached",
      "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
    ],
    ["a permission failure", "Error response from daemon: permission denied"],
    [
      "a container that vanished",
      "Error response from daemon: No such container: probe",
    ],
    [
      "an older CLI's ambiguous 404",
      `Error: No such container:path: probe:${PROBE_PATH}`,
    ],
    [
      "a missing-file signature naming a different path",
      "Error response from daemon: open /var/lib/docker/tmp: permission denied\nCould not find the file /output/traces.json in container probe",
    ],
  ])(
    "reports %s as a failed probe with the raw error, not an unshared mount",
    async (_label, daemonText) => {
      const probe = assertBindMountVisible({
        containerName: "probe",
        hostPath: join(PRIVATE_TMP, "scratch"),
        containerPath: PROBE_PATH,
        token: "token-abc",
        dockerCp: () => Promise.reject(new Error(daemonText)),
      });
      await expect(probe).rejects.not.toBeInstanceOf(BindMountNotVisibleError);
      await expect(probe).rejects.toThrow(
        `bind-mount probe \`docker cp probe:${PROBE_PATH} -\` failed: ${daemonText}`
      );
      await expect(probe).rejects.not.toThrow(UNSHARED_MOUNT);
    }
  );

  it("refuses with the unshared-mount explanation when docker create rejects the bind", async () => {
    docker.failures = { create: MOUNTS_DENIED };

    const refusal = runVerification({
      counts: { errors: 1, serverErrors: 1, slow: 1, baseline: 1 },
    });
    await expect(refusal).rejects.toBeInstanceOf(BindMountNotVisibleError);
    await expect(refusal).rejects.toThrow(
      `${UNSHARED_MOUNT} ${join(homedir(), ".cache")}${sep}tail-sampling-verify-`
    );
    await expect(refusal).rejects.toThrow(
      "(docker create rejected the bind mount)"
    );
    await expect(refusal).rejects.toThrow("Remedy: share ");
    await expect(refusal).rejects.toThrow("Mounts denied");
    expect(docker.calls.map((args) => args[0])).toEqual(["pull", "create"]);
  });

  it.each([
    [
      "a name conflict",
      'Error response from daemon: Conflict. The container name "/tail-sampling-verify-1" is already in use by container "abc". You have to remove (or rename) that container to be able to reuse that name.',
    ],
    [
      "a mount-config error that is not a sharing problem",
      'Error response from daemon: invalid mount config for type "bind": field Target must not be empty',
    ],
  ])(
    "passes %s at docker create through raw, not as an unshared mount",
    async (_label, daemonText) => {
      docker.failures = { create: daemonText };

      const failure = runVerification({
        counts: { errors: 1, serverErrors: 1, slow: 1, baseline: 1 },
      });
      await expect(failure).rejects.not.toBeInstanceOf(
        BindMountNotVisibleError
      );
      await expect(failure).rejects.toThrow(daemonText);
      await expect(failure).rejects.not.toThrow(UNSHARED_MOUNT);
      expect(docker.calls.map((args) => args[0])).toEqual(["pull", "create"]);
    }
  );
});
