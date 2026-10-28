import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
  UploadPartCopyCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  installKeyspacePrefixMiddleware,
  setKeyspacePrefixResolver,
} from "./s3-keyspace-prefix";

/**
 * ISS-12056: the keyspace prefix is exercised through a real `S3Client` and the
 * real presigner, so the assertions read the serialized HTTP request (path,
 * query, headers, body) rather than the command input. A `build` step
 * middleware captures that request and answers with a canned output, so no
 * request leaves the process.
 */

vi.mock("server-only", () => ({}));

vi.mock("./keys", () => ({
  keys: () => ({
    AWS_REGION: "us-east-1",
    AWS_ACCESS_KEY_ID: "AKIAFAKEFAKEFAKEFAKE",
    AWS_SECRET_ACCESS_KEY: "fake-secret",
    TRANSCRIPTS_BUCKET: "transcripts-bucket",
  }),
}));

const BUCKET = "test-bucket";
const PREFIX = "vibe-environments/preview_vibe_abc123/";
const FAKE_CREDENTIALS = {
  accessKeyId: "AKIAFAKEFAKEFAKEFAKE",
  secretAccessKey: "fake-secret",
};

/** The parts of the serialized `HttpRequest` the assertions read. */
const capturedRequestSchema = z.object({
  path: z.string(),
  query: z.record(z.string(), z.unknown()),
  headers: z.record(z.string(), z.string()),
  body: z.unknown(),
});

type CapturedRequest = z.infer<typeof capturedRequestSchema>;

function createCapturingClient(cannedOutput: () => object = () => ({})) {
  const client = new S3Client({
    region: "us-east-1",
    credentials: FAKE_CREDENTIALS,
  });
  const requests: CapturedRequest[] = [];
  client.middlewareStack.add(
    () => (args: { request: unknown }) => {
      requests.push(capturedRequestSchema.parse(args.request));
      return Promise.resolve({
        output: { $metadata: {}, ...cannedOutput() },
        response: {},
      });
    },
    { step: "build", priority: "low", name: "testCaptureRequest" }
  );
  installKeyspacePrefixMiddleware(client);
  return { client, requests };
}

describe("S3 keyspace prefix middleware", () => {
  beforeEach(() => {
    setKeyspacePrefixResolver(() => Promise.resolve(PREFIX));
  });

  afterEach(() => {
    setKeyspacePrefixResolver(null);
  });

  it("sends keys unchanged when no resolver is set", async () => {
    setKeyspacePrefixResolver(null);
    const { client, requests } = createCapturingClient();

    await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: "a/b" }));

    expect(requests[0].path).toBe("/a/b");
  });

  it("sends keys unchanged when the resolver answers an empty prefix", async () => {
    setKeyspacePrefixResolver(() => Promise.resolve(""));
    const { client, requests } = createCapturingClient();

    await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: "a/b" }));

    expect(requests[0].path).toBe("/a/b");
  });

  it.each([
    [
      "PutObject",
      () => new PutObjectCommand({ Bucket: BUCKET, Key: "a/b", Body: "x" }),
    ],
    ["GetObject", () => new GetObjectCommand({ Bucket: BUCKET, Key: "a/b" })],
    ["HeadObject", () => new HeadObjectCommand({ Bucket: BUCKET, Key: "a/b" })],
    [
      "DeleteObject",
      () => new DeleteObjectCommand({ Bucket: BUCKET, Key: "a/b" }),
    ],
  ])("prefixes the key of %s", async (_name, build) => {
    const { client, requests } = createCapturingClient();

    await client.send(build());

    expect(requests[0].path).toBe(`/${PREFIX}a/b`);
  });

  it("prefixes every multipart command and strips the key S3 echoes back", async () => {
    const { client, requests } = createCapturingClient(() => ({
      Key: `${PREFIX}t/x.jsonl`,
      UploadId: "u1",
    }));
    const created = await client.send(
      new CreateMultipartUploadCommand({ Bucket: BUCKET, Key: "t/x.jsonl" })
    );
    await client.send(
      new UploadPartCommand({
        Bucket: BUCKET,
        Key: "t/x.jsonl",
        UploadId: "u1",
        PartNumber: 2,
        Body: "x",
      })
    );
    const parts = await client.send(
      new ListPartsCommand({ Bucket: BUCKET, Key: "t/x.jsonl", UploadId: "u1" })
    );
    const completed = await client.send(
      new CompleteMultipartUploadCommand({
        Bucket: BUCKET,
        Key: "t/x.jsonl",
        UploadId: "u1",
        MultipartUpload: { Parts: [{ PartNumber: 1, ETag: "e" }] },
      })
    );
    await client.send(
      new AbortMultipartUploadCommand({
        Bucket: BUCKET,
        Key: "t/x.jsonl",
        UploadId: "u1",
      })
    );

    expect(requests.map((request) => request.path)).toEqual(
      new Array(5).fill(`/${PREFIX}t/x.jsonl`)
    );
    expect(created.Key).toBe("t/x.jsonl");
    expect(parts.Key).toBe("t/x.jsonl");
    expect(completed.Key).toBe("t/x.jsonl");
  });

  it("prefixes both the target key and the key half of an UploadPartCopy source", async () => {
    const { client, requests } = createCapturingClient();

    await client.send(
      new UploadPartCopyCommand({
        Bucket: BUCKET,
        Key: "t/x.jsonl",
        UploadId: "u1",
        PartNumber: 1,
        CopySource: `${BUCKET}/t/source%20key.jsonl`,
      })
    );

    expect(requests[0].path).toBe(`/${PREFIX}t/x.jsonl`);
    expect(requests[0].headers["x-amz-copy-source"]).toBe(
      `${BUCKET}/${PREFIX}t/source%20key.jsonl`
    );
  });

  it("keeps a leading slash and a version id on a CopySource", async () => {
    const { client, requests } = createCapturingClient();

    await client.send(
      new UploadPartCopyCommand({
        Bucket: BUCKET,
        Key: "t/x",
        UploadId: "u1",
        PartNumber: 1,
        CopySource: `/${BUCKET}/t/src?versionId=v1`,
      })
    );

    expect(requests[0].headers["x-amz-copy-source"]).toBe(
      `/${BUCKET}/${PREFIX}t/src?versionId=v1`
    );
  });

  it("prefixes every key in a DeleteObjects batch and strips the keys reported back", async () => {
    const { client, requests } = createCapturingClient(() => ({
      Deleted: [{ Key: `${PREFIX}a` }],
      Errors: [{ Key: `${PREFIX}b`, Code: "AccessDenied" }],
    }));

    const response = await client.send(
      new DeleteObjectsCommand({
        Bucket: BUCKET,
        Delete: { Objects: [{ Key: "a" }, { Key: "b" }], Quiet: true },
      })
    );

    const body = String(requests[0].body);
    expect(body).toContain(`<Key>${PREFIX}a</Key>`);
    expect(body).toContain(`<Key>${PREFIX}b</Key>`);
    expect(body).toContain("<Quiet>true</Quiet>");
    expect(response.Deleted).toEqual([{ Key: "a" }]);
    expect(response.Errors).toEqual([{ Key: "b", Code: "AccessDenied" }]);
  });

  it("prefixes a listing's Prefix and StartAfter and strips the listed keys", async () => {
    const { client, requests } = createCapturingClient(() => ({
      Prefix: `${PREFIX}attachments/`,
      Contents: [{ Key: `${PREFIX}attachments/one`, Size: 3 }],
      CommonPrefixes: [{ Prefix: `${PREFIX}attachments/org/` }],
    }));

    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: "attachments/",
        StartAfter: "attachments/a",
      })
    );

    expect(requests[0].query).toMatchObject({
      prefix: `${PREFIX}attachments/`,
      "start-after": `${PREFIX}attachments/a`,
    });
    expect(response.Prefix).toBe("attachments/");
    expect(response.Contents).toEqual([{ Key: "attachments/one", Size: 3 }]);
    expect(response.CommonPrefixes).toEqual([{ Prefix: "attachments/org/" }]);
  });

  it("scopes a listing that names no Prefix to the keyspace", async () => {
    const { client, requests } = createCapturingClient();

    await client.send(new ListObjectsV2Command({ Bucket: BUCKET }));

    expect(requests[0].query).toMatchObject({ prefix: PREFIX });
  });

  it("does not mutate the command, so a re-sent command is prefixed once", async () => {
    const { client, requests } = createCapturingClient();
    const command = new GetObjectCommand({ Bucket: BUCKET, Key: "a/b" });

    await client.send(command);
    await client.send(command);

    expect(command.input.Key).toBe("a/b");
    expect(requests.map((request) => request.path)).toEqual([
      `/${PREFIX}a/b`,
      `/${PREFIX}a/b`,
    ]);
  });

  it("rejects the call, sending nothing, when the resolver fails", async () => {
    setKeyspacePrefixResolver(() => Promise.reject(new Error("db down")));
    const { client, requests } = createCapturingClient();

    await expect(
      client.send(new PutObjectCommand({ Bucket: BUCKET, Key: "a", Body: "x" }))
    ).rejects.toThrow("db down");
    expect(requests).toHaveLength(0);
  });

  it.each(["vibe-environments/preview_x", "/vibe-environments/preview_x/"])(
    "rejects the call when the resolver answers the malformed prefix %s",
    async (prefix) => {
      setKeyspacePrefixResolver(() => Promise.resolve(prefix));
      const { client, requests } = createCapturingClient();

      await expect(
        client.send(new GetObjectCommand({ Bucket: BUCKET, Key: "a" }))
      ).rejects.toThrow("S3 keyspace prefix");
      expect(requests).toHaveLength(0);
    }
  );

  it.each([
    ["GET", () => new GetObjectCommand({ Bucket: BUCKET, Key: "a/b.jsonl" })],
    ["PUT", () => new PutObjectCommand({ Bucket: BUCKET, Key: "a/b.jsonl" })],
  ])(
    "points a presigned %s URL at the prefixed key",
    async (_method, build) => {
      const client = new S3Client({
        region: "us-east-1",
        credentials: FAKE_CREDENTIALS,
      });
      installKeyspacePrefixMiddleware(client);

      const url = new URL(
        await getSignedUrl(client, build(), { expiresIn: 60 })
      );

      expect(url.pathname).toBe(`/${PREFIX}a/b.jsonl`);
      expect(url.searchParams.get("X-Amz-Signature")).not.toBeNull();
    }
  );
});

describe("setS3KeyspacePrefixResolver on the shared client", () => {
  afterEach(async () => {
    const { setS3KeyspacePrefixResolver } = await import("./s3-client");
    setS3KeyspacePrefixResolver(null);
  });

  it("presigns the shared client's URLs under the resolver's prefix, and stops when cleared", async () => {
    const { s3Client, setS3KeyspacePrefixResolver } = await import(
      "./s3-client"
    );
    const command = () =>
      new PutObjectCommand({ Bucket: "transcripts-bucket", Key: "a/b.jsonl" });

    setS3KeyspacePrefixResolver(() => Promise.resolve(PREFIX));
    const prefixed = new URL(await getSignedUrl(s3Client, command()));
    setS3KeyspacePrefixResolver(null);
    const plain = new URL(await getSignedUrl(s3Client, command()));

    expect(prefixed.pathname).toBe(`/${PREFIX}a/b.jsonl`);
    expect(plain.pathname).toBe("/a/b.jsonl");
  });

  // ISS-12135: apps/api sets the resolver from its instrumentation entry, and a
  // route bundle can hold its own copy of these modules. The route's copy must
  // still sign under the prefix.
  it("presigns through a second module instance under the resolver the first one set", async () => {
    const installer = await import("./s3-client");
    vi.resetModules();
    const route = await import("./s3-client");
    expect(route.s3Client).not.toBe(installer.s3Client);
    const command = () =>
      new GetObjectCommand({ Bucket: "transcripts-bucket", Key: "a/b.jsonl" });

    const before = new URL(await getSignedUrl(route.s3Client, command()));
    installer.setS3KeyspacePrefixResolver(() => Promise.resolve(PREFIX));
    const prefixed = new URL(await getSignedUrl(route.s3Client, command()));

    expect(before.pathname).toBe("/a/b.jsonl");
    expect(prefixed.pathname).toBe(`/${PREFIX}a/b.jsonl`);
  });
});
