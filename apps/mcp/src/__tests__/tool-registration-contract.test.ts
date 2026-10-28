/**
 * The registered tool contract for every MCP tool, pinned as literals.
 *
 * ISS-10135. Handler suites drive the raw callback the register function hands
 * to `registerTool`, so the MCP SDK never applies `inputSchema` in test. A field
 * can be deleted, renamed, flipped required<->optional, or have its validator
 * loosened, and every one of those suites stays green while a real client
 * silently loses the argument — the registered schema is the only thing a
 * client ever sees.
 *
 * What a client sees is precisely the JSON Schema the SDK derives: its
 * `tools/list` handler converts `inputSchema` with `toJSONSchema(schema,
 * { target: "draft-7", io: "input" })` and `outputSchema` with the same call at
 * `io: "output"` (`@modelcontextprotocol/sdk` 1.29.0,
 * `server/zod-json-schema-compat.js`). So each field is pinned as a compact
 * rendering of exactly that JSON Schema: type, format or regex, enum members,
 * and bounds, with `?` on the name for a field a client may omit. Swapping
 * `z.uuid()` for `z.string()`, dropping an enum member, or widening a range all
 * change the rendering and red the tool's case.
 *
 * The corollary is the boundary: a `.refine()` predicate has no JSON Schema
 * representation, so it never reaches a client and is not pinned here. Server
 * behaviour behind a refinement is the owning tool suite's contract, not this
 * file's.
 *
 * The expectations below are INDEPENDENT LITERALS, deliberately duplicating the
 * shipped schemas. That duplication is the whole mechanism: a test that derived
 * its expectation from the schema it polices could not fail. DRY is the wrong
 * instinct here.
 *
 * What this pins and what it does not: it is a frozen baseline of the contract
 * as shipped at bc5dae6c29, so it fails on drift. It does not assert that the
 * contract is correct — a field that is wrong today is wrong in this table too,
 * and a field already registered as `z.any()` is recorded as `any` rather than
 * endorsed. Per-tool suites (`update-project-registration.test.ts` and friends)
 * own the semantics of individual fields; this file owns the wire shape.
 *
 * Adding a tool: add its row here. The name set is compared both ways, so a new
 * tool fails this file until its fields are written down.
 */

import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import { TOOL_REGISTRATIONS } from "../tool-registrations.js";
import { createUrlBuilder } from "../tools/tool-utils.js";

/**
 * Every tool's input fields, in registration order, as
 * `name[?]:<json-schema rendering>`.
 */
const TOOL_INPUT_CONTRACT = {
  ping: [],
  search: [
    "q:string(2..200)",
    "mode?:enum(fulltext,prefix)",
    "types?:enum(document,project,loop,agent_session,comment,pull_request,branch,agent_component)[]",
    "limit?:integer(1..100)",
    "cursor?:string(1..2048)",
  ],
  "list-projects": ["limit?:integer(1..100)", "offset?:integer(0..)"],
  "get-project": ["projectId:string(1..)"],
  "list-teams": ["limit?:integer(1..100)", "offset?:integer(0..)"],
  "create-project": [
    "name:string",
    "teamId?:string:uuid",
    "description?:string",
    "priority?:enum(LOW,MEDIUM,HIGH,URGENT)",
    "status?:enum(NOT_STARTED,IN_PROGRESS,COMPLETED,ARCHIVED)",
  ],
  "update-project": [
    "projectId:string(1..)",
    "name?:string",
    "teamIds?:string:uuid[](1..100)",
    "description?:string",
    "priority?:enum(LOW,MEDIUM,HIGH,URGENT)|null",
    "status?:enum(NOT_STARTED,IN_PROGRESS,COMPLETED,ARCHIVED)",
  ],
  "list-documents": [
    "projectId?:string",
    "assigneeId?:string",
    "type?:enum(PRD,IMPLEMENTATION_PLAN,TEMPLATE,FEATURE,DOC,ISSUE)",
    "limit?:integer(1..100)",
    "offset?:integer(0..)",
    "includeParentArtifact?:boolean",
  ],
  "get-document": [
    "documentId:string(1..)",
    "includeContent?:boolean",
    "contentMaxChars?:integer(200..120000)",
    "includeParentArtifact?:boolean",
    "resolveInlineImages?:boolean",
    "includeImages?:boolean",
  ],
  "get-document-content": [
    "documentId:string(1..)",
    "version?:integer(>0..)",
    "cursor?:string~^[A-Za-z0-9_-]+$(1..2048)",
    "chunkSizeBytes?:integer(1..65536)",
  ],
  "create-document": [
    "title:string",
    "type:enum(PRD,IMPLEMENTATION_PLAN,FEATURE,DOC,ISSUE)",
    "projectId?:string(1..)",
    "content:string",
    "assigneeId?:string:uuid|null",
    "approverId?:string:uuid|null",
    "priority?:enum(LOW,MEDIUM,HIGH,URGENT)",
    "dueDate?:string:date|string:date-time|null",
    "fileName?:string",
    "status?:enum(DRAFT,IN_REVIEW,CHANGES_REQUESTED,APPROVED,EXECUTED,OBSOLETE,TRIAGE,BACKLOG,TODO,IN_PROGRESS,BLOCKED,DONE,CANCELED)",
    "repositorySelection?:{primary:{fullName:string,branch?:string|null},additional?:{fullName:string,branch?:string|null}[]}",
    "inlineImages?:{placeholder:string(1..200),filename:string(1..255),mimeType:enum(image/jpeg,image/png,image/gif,image/webp),dataBase64:string(1..699052),altText?:string(..500)}[](..5)",
  ],
  "create-document-thread": [
    "documentId:string(1..)",
    "body:string(1..)",
    "anchorText?:string(1..)",
  ],
  "get-document-comments": [
    "documentId:string(1..)",
    "status?:enum(OPEN,RESOLVED)",
  ],
  "update-document": [
    "documentId:string(1..)",
    "projectId?:string|null",
    "title?:string",
    "status?:enum(DRAFT,IN_REVIEW,CHANGES_REQUESTED,APPROVED,EXECUTED,OBSOLETE,TRIAGE,BACKLOG,TODO,IN_PROGRESS,BLOCKED,DONE,CANCELED)",
    "expectedStatus?:string(1..)",
    "assigneeId?:string:uuid|null",
    "approverId?:string:uuid|null",
    "priority?:enum(LOW,MEDIUM,HIGH,URGENT)|null",
    "expectedPriority?:enum(LOW,MEDIUM,HIGH,URGENT)|null",
    "dueDate?:string:date|string:date-time|null",
    "fileName?:string",
  ],
  "move-artifact": [
    "projectId:string(1..)",
    "artifactId:string(1..)",
    "position:enum(top,bottom,before,after)",
    "referenceArtifactId?:string",
  ],
  "create-document-version": [
    "documentId:string(1..)",
    "content:string",
    "inlineImages?:{placeholder:string(1..200),filename:string(1..255),mimeType:enum(image/jpeg,image/png,image/gif,image/webp),dataBase64:string(1..699052),altText?:string(..500)}[](..5)",
  ],
  "list-document-versions": [
    "documentId:string(1..)",
    "limit?:integer(1..100)",
    "offset?:integer(0..)",
  ],
  "list-attachments": [
    "entityId:string(1..)",
    "purpose?:enum(context,inline,all)",
    "limit?:integer(1..100)",
    "offset?:integer(0..)",
  ],
  "upload-attachment": [
    "entityId:string(1..)",
    "filename:string(1..)",
    "mimeType:string(1..)",
    "sizeBytes:integer(>0..524288000)",
    "purpose?:enum(context,inline)",
  ],
  "create-inline-image-attachment": [
    "entityId:string(1..)",
    "filename:string(1..)",
    "mimeType:enum(image/jpeg,image/png,image/gif,image/webp)",
    "dataBase64:string(1..699052)",
    "altText?:string",
  ],
  "download-attachment": ["entityId:string(1..)", "attachmentId:string"],
  "delete-attachment": ["entityId:string(1..)", "attachmentId:string"],
  "get-me": [],
  "list-users": ["limit?:integer(1..100)", "offset?:integer(0..)"],
  "list-artifact-links": [
    "artifactId:string",
    "linkType?:enum(PRODUCES,BLOCKS,RELATES_TO)",
    "direction?:enum(source,target,both)",
    "mode?:enum(direct,tree)",
    "maxDepth?:integer(1..10)",
    "limit?:integer(1..100)",
    "offset?:integer(0..)",
  ],
  "create-artifact-link": [
    "sourceId:string",
    "targetId:string",
    "linkType:enum(PRODUCES,BLOCKS,RELATES_TO)",
  ],
  "delete-artifact-link": ["linkId:string:uuid"],
  "list-tags": [
    "limit?:integer(1..100)",
    "offset?:integer(0..10000)",
    "search?:string(1..)",
  ],
  "tag-artifact": ["documentId:string(1..)", "tagName:string(1..)"],
  "untag-artifact": ["documentId:string(1..)", "tagName:string(1..)"],
  create_branch_artifact: [
    "projectId:string:uuid",
    "sourceArtifactId?:string:uuid|null",
    "branchName:string(1..)",
    "defaultBranch?:string(1..)|null",
    "baseBranch?:string(1..)|null",
    "baseBranchSource?:enum(pull_request_base,harness_input,desktop_pull_request_base,mcp_input,migration_pr_base,repository_default)|null",
    "headSha?:string(1..)|null",
    "headShaSource?:enum(push_webhook,pull_request_webhook,harness_input,mcp_input,explicit_sync,migration_pr_head)|null",
  ],
  "list-templates": ["limit?:integer(1..100)", "offset?:integer(0..)"],
  "get-github-status": [],
  "get-linear-status": [],
  "get-google-status": [],
  "verify-audit-ledger": [],
  "get-agent-session-usage": [
    "startDate?:string",
    "endDate?:string",
    "harness?:string",
    "viewerScope?:enum(self,organization,team)",
    "teamId?:string:uuid",
    "quality?:enum(substantive,idle,all)",
  ],
  "get-agent-session-analytics": [
    "startDate?:string",
    "endDate?:string",
    "harness?:string",
    "viewerScope?:enum(self,organization,team)",
    "teamId?:string:uuid",
    "quality?:enum(substantive,idle,all)",
  ],
  "list-agent-sessions": [
    "startDate?:string",
    "endDate?:string",
    "harness?:string",
    "status?:string",
    "userId?:string:uuid",
    "viewerScope?:enum(self,organization,team)",
    "teamId?:string:uuid",
    "quality?:enum(substantive,idle,all)",
    "limit?:integer(1..100)",
    "offset?:integer(0..10000)",
  ],
  "get-agent-session-transcript": ["sessionId:string:uuid"],
  "list-session-comments": [
    "sessionId?:string(1..500)",
    "sessionUrl?:string:uri",
    "computeTargetId?:string:uuid",
    "status?:enum(OPEN,RESOLVED)",
    "limit?:integer(1..100)",
    "offset?:integer(0..)",
  ],
  "list-agent-components": [
    "kinds?:enum(subagent,command,skill,workflow,mcp,hook,config,plugin,tool,orchestration)[]",
    "collaborator?:string",
    "owner?:string",
    "source?:string",
    "harness?:enum(claude,codex,opencode,both)",
    "search?:string",
    "startDate?:string",
    "endDate?:string",
    "sortBy?:enum(name,type,metric,source,harness,invocations,sessions)",
    "sortDir?:enum(asc,desc)",
    "limit?:integer(1..100)",
    "offset?:integer(0..10000)",
  ],
  "get-agent-component": [
    "slug:string",
    "includePrompt?:boolean",
    "promptMaxChars?:integer(200..120000)",
    "versionHash?:string",
  ],
} as const satisfies Record<string, readonly string[]>;

/**
 * The tools that declare a structured `outputSchema`, and the fields each one
 * promises. Pinned in the same shape as the inputs because a dropped or
 * loosened output field is the same silent loss: a model reads this to know
 * what it is getting back.
 */
const TOOL_OUTPUT_CONTRACT = {
  "get-document-content": [
    "documentId:string:uuid",
    "resolvedVersion:integer(>0..)",
    "content:string",
    "byteStart:integer(0..)",
    "byteEndExclusive:integer(0..)",
    "returnedBytes:integer(0..)",
    "totalBytes:integer(0..)",
    "contentSha256:string~^[a-f0-9]{64}$",
    "nextCursor:string~^[A-Za-z0-9_-]+$(..2048)|null",
  ],
  "create-document": [
    "id?:string",
    "organizationId?:string",
    "projectId?:string|null",
    "slug?:string",
    "title?:string",
    "type?:string",
    "status?:string",
    "priority?:string",
    "dueDate?:string|null",
    "latestVersion?:integer",
    "fileName?:string|null",
    "createdById?:string",
    "createdBy?:{id?:string,email?:string|null,firstName?:string|null,lastName?:string|null,avatarUrl?:string|null}closed|null",
    "assigneeId?:string|null",
    "assignee?:{id?:string,email?:string|null,firstName?:string|null,lastName?:string|null,avatarUrl?:string|null}closed|null",
    "approverId?:string|null",
    "approver?:{id?:string,email?:string|null,firstName?:string|null,lastName?:string|null,avatarUrl?:string|null}closed|null",
    "repositorySnapshot?:{repositories:{fullName:string,role?:enum(primary,additional),position?:integer(0..),branch?:string|null}closed[],source?:enum(project_defaults,loop_selection,parent_artifact,legacy,branch_link,none),createdAt?:string}closed",
    "templateForType?:string|null",
    "sortOrder?:number|null",
    "createdAt?:string",
    "updatedAt?:string",
    "webUrl:string|null",
    "versionContent?:string",
    "inlineImages?:{placeholder:string(1..),attachmentId:string(1..),attachmentRef:string~^attachment:\\/\\/.*(14..),markdownImage:string(1..)}closed[]",
    "operationReceipt?:{operationId:string,outcome:string(1..)}",
  ],
  "create-document-version": [
    "id?:string",
    "organizationId?:string",
    "projectId?:string|null",
    "slug?:string",
    "title?:string",
    "type?:string",
    "status?:string",
    "priority?:string|null",
    "latestVersion?:integer",
    "fileName?:string|null",
    "createdById?:string",
    "createdBy?:any|null",
    "assigneeId?:string|null",
    "assignee?:any|null",
    "approverId?:string|null",
    "approver?:any|null",
    "repositorySnapshot?:any",
    "templateForType?:string|null",
    "sortOrder?:number|null",
    "createdAt?:string",
    "updatedAt?:string",
    "project?:any|null",
    "generationStatus?:any",
    "customFields?:any[]",
    "tags?:any[]",
    "latestVersionContent?:string|null",
    "webUrl:string|null",
    "versionContent?:string",
    "version?:{id?:string,documentId?:string,version?:integer,content?:string|null,createdById?:string|null,createdAt?:string|null}closed",
    "inlineImages?:{placeholder:string,attachmentId:string,attachmentRef:string~^attachment:\\/\\/.*,markdownImage:string,attachment:{id:string,artifactId:string|null,filename:string,mimeType:enum(image/jpeg,image/png,image/gif,image/webp),sizeBytes:integer(0..)|null,purpose:enum(context,inline)|null,createdAt:string|null,createdById:string|null,previewUrl?:string}closed}closed[]",
    "operationReceipt?:{operationId:string,outcome:string(1..)}",
  ],
  "create-inline-image-attachment": [
    "attachmentId:string",
    "attachmentRef:string~^attachment:\\/\\/.*",
    "markdownImage:string",
    "attachment:{id:string,artifactId:string|null,filename:string,mimeType:enum(image/jpeg,image/png,image/gif,image/webp),sizeBytes:integer(0..)|null,purpose:enum(context,inline)|null,createdAt:string|null,createdById:string|null,previewUrl?:string}closed",
    "operationReceipt?:{operationId:string,outcome:string(1..)}",
  ],
} as const satisfies Record<string, readonly string[]>;

const SAFE_INT = Number.MAX_SAFE_INTEGER;

type JsonSchemaNode = {
  type?: string;
  format?: string;
  pattern?: string;
  enum?: readonly unknown[];
  items?: JsonSchemaNode;
  anyOf?: readonly JsonSchemaNode[];
  properties?: Record<string, JsonSchemaNode>;
  required?: readonly string[];
  additionalProperties?: unknown;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
};

type RegisteredConfig = {
  description?: string;
  inputSchema?: Record<string, ZodType>;
  outputSchema?: Record<string, ZodType>;
};

type RegisteredTool = {
  catalogName: string;
  name: string;
  config: RegisteredConfig;
};

/** One catalog entry's registration outcome; a throw is captured, not raised. */
type CatalogRegistration = {
  catalogName: string;
  tools: RegisteredTool[];
  error?: unknown;
};

/** `z.int()` emits the safe-integer range; that is noise, not a bound. */
function describeBound(node: JsonSchemaNode): string {
  const lower = node.minLength ?? node.minItems ?? node.minimum;
  const upper = node.maxLength ?? node.maxItems ?? node.maximum;
  let low = "";
  if (node.exclusiveMinimum !== undefined) {
    low = `>${node.exclusiveMinimum}`;
  } else if (lower !== undefined && lower !== -SAFE_INT) {
    low = String(lower);
  }
  let high = "";
  if (node.exclusiveMaximum !== undefined) {
    high = `<${node.exclusiveMaximum}`;
  } else if (upper !== undefined && upper !== SAFE_INT) {
    high = String(upper);
  }
  return low === "" && high === "" ? "" : `(${low}..${high})`;
}

function describeCore(node: JsonSchemaNode): string {
  if (node.enum) {
    return `enum(${node.enum.join(",")})`;
  }
  if (node.type === "object") {
    const required = new Set(node.required ?? []);
    const fields = Object.entries(node.properties ?? {}).map(
      ([key, child]) =>
        `${key}${required.has(key) ? "" : "?"}:${describeSchema(child)}`
    );
    const closed = node.additionalProperties === false ? "closed" : "";
    return `{${fields.join(",")}}${closed}`;
  }
  if (node.type === "array") {
    return `${describeSchema(node.items ?? {})}[]`;
  }
  return node.type ?? "any";
}

/** Render one JSON Schema node compactly, keeping every client-visible check. */
function describeSchema(node: JsonSchemaNode): string {
  if (node.anyOf) {
    return node.anyOf.map(describeSchema).join("|");
  }
  let refinement = "";
  if (node.format) {
    refinement = `:${node.format}`;
  } else if (node.pattern) {
    refinement = `~${node.pattern}`;
  }
  return `${describeCore(node)}${refinement}${describeBound(node)}`;
}

/**
 * Render one registered field the way the SDK publishes it. `unrepresentable`
 * is left at its default so a schema JSON Schema cannot express throws here
 * rather than quietly widening to `any`.
 */
function describeFields(
  shape: Record<string, ZodType> | undefined,
  io: "input" | "output"
): string[] {
  return Object.entries(shape ?? {}).map(([name, schema]) => {
    const optional = schema.safeParse(undefined).success;
    const json = z.toJSONSchema(schema, { io, target: "draft-7" });
    return `${name}${optional ? "?" : ""}:${describeSchema(json as JsonSchemaNode)}`;
  });
}

/**
 * Drive the real catalog the way `createMcpServer` does, and capture what each
 * entry actually hands the SDK. Register functions only call `registerTool`, so
 * the api client and url builder are never touched. A register function that
 * throws is recorded against its entry instead of aborting the file, so the red
 * names the tool.
 */
function registerCatalog(): CatalogRegistration[] {
  return TOOL_REGISTRATIONS.map((entry) => {
    const tools: RegisteredTool[] = [];
    const server = {
      registerTool: (name: string, config: RegisteredConfig) => {
        tools.push({ catalogName: entry.name, name, config });
      },
    };
    try {
      entry.register(
        server as never,
        {} as ApiClient,
        createUrlBuilder(() => null)
      );
    } catch (error) {
      return { catalogName: entry.name, tools, error };
    }
    return { catalogName: entry.name, tools };
  });
}

let catalogCache: CatalogRegistration[] | undefined;

/** Registered lazily so nothing runs at module scope. */
function catalog(): CatalogRegistration[] {
  catalogCache ??= registerCatalog();
  return catalogCache;
}

function registeredTools(): RegisteredTool[] {
  return catalog().flatMap((entry) => entry.tools);
}

function toolNamed(name: string): RegisteredTool | undefined {
  return registeredTools().find((tool) => tool.name === name);
}

describe("MCP tool registration contract", () => {
  it("registers every catalog entry without throwing", () => {
    const failed = catalog()
      .filter((entry) => entry.error !== undefined)
      .map((entry) => `${entry.catalogName}: ${entry.error}`);
    expect(failed).toEqual([]);
  });

  it("registers exactly the tools this file pins, and no others", () => {
    expect(
      registeredTools()
        .map((tool) => tool.name)
        .sort()
    ).toEqual(Object.keys(TOOL_INPUT_CONTRACT).sort());
  });

  it("registers exactly one tool per catalog entry", () => {
    expect(registeredTools()).toHaveLength(TOOL_REGISTRATIONS.length);
  });

  for (const [toolName, fields] of Object.entries(TOOL_INPUT_CONTRACT)) {
    it(`${toolName} offers clients exactly the pinned input contract`, () => {
      const tool = toolNamed(toolName);
      expect(tool).toBeDefined();
      expect(describeFields(tool?.config.inputSchema, "input")).toEqual(fields);
    });
  }

  for (const [toolName, fields] of Object.entries(TOOL_OUTPUT_CONTRACT)) {
    it(`${toolName} promises clients exactly the pinned output contract`, () => {
      const tool = toolNamed(toolName);
      expect(tool).toBeDefined();
      expect(tool?.config.outputSchema).toBeDefined();
      expect(describeFields(tool?.config.outputSchema, "output")).toEqual(
        fields
      );
    });
  }

  // The catalog name gates scopes (`hasRequiredScopes`, `requiresWrite`) while
  // the registered name is what a client calls. If they drift, a tool is gated
  // under a name nothing offers and ships with whatever the default allows.
  it("gates each tool under the name it registers", () => {
    for (const tool of registeredTools()) {
      expect(tool.name).toBe(tool.catalogName);
    }
  });

  // Presence only. Pinning the prose would red on every wording improvement to
  // a surface whose descriptions are meant to be iterated on — so a reworded
  // description passes here, and a deleted one does not.
  it("gives every tool a non-empty description", () => {
    for (const tool of registeredTools()) {
      expect(tool.config.description?.trim()).toBeTruthy();
    }
  });

  it("declares an output schema on exactly the pinned tools", () => {
    const withOutput = registeredTools()
      .filter((tool) => tool.config.outputSchema !== undefined)
      .map((tool) => tool.name)
      .sort();
    expect(withOutput).toEqual(Object.keys(TOOL_OUTPUT_CONTRACT).sort());
  });
});
