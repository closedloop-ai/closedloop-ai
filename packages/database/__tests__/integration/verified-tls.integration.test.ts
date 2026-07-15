import {
  execFileSync,
  execFile as execFileWithCallback,
} from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFile = promisify(execFileWithCallback);

const CERTIFICATE_VERIFICATION_ERROR_REGEX =
  /(self-signed certificate|unable to verify|certificate verify|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|DEPTH_ZERO_SELF_SIGNED_CERT)/i;
const POSTGRES_PASSWORD = "testpass";
const POSTGRES_USER = "testuser";
const POSTGRES_DB = "testdb";
const POSTGRES_IMAGE = "postgres:16";
const READINESS_ATTEMPTS = 30;
const READINESS_DELAY_MS = 1000;

const TLS_FIXTURE_PREREQUISITES = checkTlsFixturePrerequisites();

describe.skipIf(!TLS_FIXTURE_PREREQUISITES.available)(
  `verified TLS Postgres handshake${TLS_FIXTURE_PREREQUISITES.reason}`,
  () => {
    let fixture: TlsPostgresFixture | null = null;

    beforeAll(async () => {
      fixture = await startTlsPostgresFixture();
    });

    afterAll(async () => {
      await fixture?.dispose();
    });

    it("accepts a real connection when the generated CA is trusted", async () => {
      if (!fixture) {
        throw new Error("TLS fixture was not initialized");
      }

      const result = await queryFixture(fixture, {
        rejectUnauthorized: true,
        ca: [fixture.ca],
      });

      expect(result).toBe(1);
    });

    it("rejects a real connection when no trusted CA is supplied", async () => {
      if (!fixture) {
        throw new Error("TLS fixture was not initialized");
      }

      await expect(
        queryFixture(fixture, { rejectUnauthorized: true })
      ).rejects.toThrow(CERTIFICATE_VERIFICATION_ERROR_REGEX);
    });

    it("rejects a real connection when the wrong CA is supplied", async () => {
      if (!fixture) {
        throw new Error("TLS fixture was not initialized");
      }

      await expect(
        queryFixture(fixture, {
          rejectUnauthorized: true,
          ca: [fixture.wrongCa],
        })
      ).rejects.toThrow(CERTIFICATE_VERIFICATION_ERROR_REGEX);
    });

    it("connects to the untrusted certificate only through explicit insecure TLS", async () => {
      if (!fixture) {
        throw new Error("TLS fixture was not initialized");
      }

      const result = await queryFixture(fixture, {
        rejectUnauthorized: false,
      });

      expect(result).toBe(1);
    });
  }
);

type TlsPostgresFixture = {
  ca: string;
  connectionString: string;
  containerId: string;
  dispose: () => Promise<void>;
  tempDir: string;
  wrongCa: string;
};

type CommandResult = {
  stderr: string;
  stdout: string;
};

async function startTlsPostgresFixture(): Promise<TlsPostgresFixture> {
  const tempDir = await mkdtemp(path.join(tmpdir(), "database-tls-test-"));
  let containerId: string | null = null;

  try {
    const certs = await generateCertificates(tempDir);
    const dockerRun = await runCommand("docker", [
      "run",
      "--detach",
      "--publish",
      "127.0.0.1::5432",
      "--env",
      `POSTGRES_PASSWORD=${POSTGRES_PASSWORD}`,
      "--env",
      `POSTGRES_USER=${POSTGRES_USER}`,
      "--env",
      `POSTGRES_DB=${POSTGRES_DB}`,
      "--volume",
      `${tempDir}:/input-certs:ro`,
      "--entrypoint",
      "bash",
      POSTGRES_IMAGE,
      "-lc",
      [
        'export PATH="$PATH:/usr/lib/postgresql/16/bin"',
        "mkdir -p /var/lib/postgresql/tls",
        "cp /input-certs/server.crt /var/lib/postgresql/tls/server.crt",
        "cp /input-certs/server.key /var/lib/postgresql/tls/server.key",
        "chown postgres:postgres /var/lib/postgresql/tls/server.crt /var/lib/postgresql/tls/server.key",
        "chmod 600 /var/lib/postgresql/tls/server.key",
        "exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/var/lib/postgresql/tls/server.crt -c ssl_key_file=/var/lib/postgresql/tls/server.key",
      ].join(" && "),
    ]);
    containerId = dockerRun.stdout.trim();
    const activeContainerId = containerId;
    const port = await getMappedPort(containerId);
    const fixture = {
      ca: certs.ca,
      connectionString: `postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:${port}/${POSTGRES_DB}`,
      containerId: activeContainerId,
      dispose: async () => {
        await cleanupTlsFixtureResources(activeContainerId, tempDir);
      },
      tempDir,
      wrongCa: certs.wrongCa,
    };

    await waitForPostgres(fixture);

    return fixture;
  } catch (error) {
    try {
      await cleanupTlsFixtureResources(containerId, tempDir);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Failed to start TLS Postgres fixture and clean up resources"
      );
    }
    throw error;
  }
}

async function generateCertificates(
  tempDir: string
): Promise<{ ca: string; wrongCa: string }> {
  const serverExtensionPath = path.join(tempDir, "server.ext");
  await writeFile(
    serverExtensionPath,
    ["subjectAltName=DNS:localhost,IP:127.0.0.1", ""].join("\n")
  );

  await runCommand("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-days",
    "1",
    "-nodes",
    "-keyout",
    path.join(tempDir, "ca.key"),
    "-out",
    path.join(tempDir, "ca.crt"),
    "-subj",
    "/CN=database-test-ca",
  ]);
  await runCommand("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-days",
    "1",
    "-nodes",
    "-keyout",
    path.join(tempDir, "wrong-ca.key"),
    "-out",
    path.join(tempDir, "wrong-ca.crt"),
    "-subj",
    "/CN=database-test-wrong-ca",
  ]);
  await runCommand("openssl", [
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    path.join(tempDir, "server.key"),
    "-out",
    path.join(tempDir, "server.csr"),
    "-subj",
    "/CN=localhost",
  ]);
  await runCommand("openssl", [
    "x509",
    "-req",
    "-in",
    path.join(tempDir, "server.csr"),
    "-CA",
    path.join(tempDir, "ca.crt"),
    "-CAkey",
    path.join(tempDir, "ca.key"),
    "-CAcreateserial",
    "-out",
    path.join(tempDir, "server.crt"),
    "-days",
    "1",
    "-sha256",
    "-extfile",
    serverExtensionPath,
  ]);

  const ca = await readText(path.join(tempDir, "ca.crt"));
  const wrongCa = await readText(path.join(tempDir, "wrong-ca.crt"));

  return { ca, wrongCa };
}

async function queryFixture(
  fixture: TlsPostgresFixture,
  ssl: pg.PoolConfig["ssl"]
): Promise<number> {
  const pool = new pg.Pool({
    connectionString: fixture.connectionString,
    ssl,
  });

  try {
    const result = await pool.query<{ ok: number }>("SELECT 1 AS ok");
    return result.rows[0]?.ok ?? 0;
  } finally {
    await pool.end();
  }
}

async function waitForPostgres(fixture: TlsPostgresFixture): Promise<void> {
  let lastError: unknown;

  for (let attempt = 0; attempt < READINESS_ATTEMPTS; attempt += 1) {
    try {
      await queryFixture(fixture, {
        rejectUnauthorized: true,
        ca: [fixture.ca],
      });
      return;
    } catch (error) {
      lastError = error;
      await delay(READINESS_DELAY_MS);
    }
  }

  throw new Error(
    `Timed out waiting for TLS Postgres fixture: ${String(lastError)}`
  );
}

async function getMappedPort(containerId: string): Promise<string> {
  const result = await runCommand("docker", ["port", containerId, "5432/tcp"]);
  const address = result.stdout.trim();
  const port = address.split(":").at(-1);

  if (!port) {
    throw new Error(`Unable to parse mapped Postgres port from: ${address}`);
  }

  return port;
}

async function stopContainer(containerId: string): Promise<void> {
  await runCommand("docker", ["rm", "--force", containerId]);
}

async function cleanupTlsFixtureResources(
  containerId: string | null,
  tempDir: string
): Promise<void> {
  const cleanupSteps: Array<{ name: string; run: () => Promise<void> }> = [
    {
      name: "remove temp certificate directory",
      run: () => rm(tempDir, { force: true, recursive: true }),
    },
  ];

  if (containerId) {
    cleanupSteps.push({
      name: "remove Docker container",
      run: () => stopContainer(containerId),
    });
  }

  const results = await Promise.allSettled(
    cleanupSteps.map((step) => step.run())
  );
  const failures = results.flatMap((result, index) => {
    if (result.status === "fulfilled") {
      return [];
    }

    return [
      {
        error: result.reason,
        name: cleanupSteps[index]?.name ?? "unknown cleanup step",
      },
    ];
  });

  if (failures.length === 0) {
    return;
  }

  if (failures.length === 1) {
    const failure = failures[0];
    throw new Error(`TLS fixture cleanup failed: ${failure.name}`, {
      cause: failure.error,
    });
  }

  throw new AggregateError(
    failures.map((failure) => failure.error),
    `TLS fixture cleanup failed: ${failures
      .map((failure) => failure.name)
      .join(", ")}`
  );
}

async function runCommand(
  command: string,
  args: readonly string[]
): Promise<CommandResult> {
  try {
    return await execFile(command, [...args], {
      maxBuffer: 1024 * 1024 * 10,
    });
  } catch (error) {
    if (process.env.CI === "true") {
      throw error;
    }
    throw new Error(
      `TLS fixture command failed locally: ${command} ${args.join(" ")}`,
      { cause: error }
    );
  }
}

function readText(filePath: string): Promise<string> {
  return readFile(filePath, "utf8");
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function checkTlsFixturePrerequisites():
  | { available: true; reason: "" }
  | { available: false; reason: string } {
  if (process.env.CI === "true") {
    return { available: true, reason: "" };
  }

  const missingCommands: string[] = [];

  if (!commandSucceeds("openssl", ["version"])) {
    missingCommands.push("OpenSSL");
  }
  if (!commandSucceeds("docker", ["info"])) {
    missingCommands.push("Docker");
  }

  if (missingCommands.length > 0) {
    return {
      available: false,
      reason: ` skipped locally because ${missingCommands.join(
        " and "
      )} is unavailable`,
    };
  }

  return { available: true, reason: "" };
}

function commandSucceeds(command: string, args: readonly string[]): boolean {
  try {
    execFileSync(command, [...args], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
