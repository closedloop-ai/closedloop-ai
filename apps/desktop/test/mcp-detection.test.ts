import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  normalizeMcpServerUrl,
  parseClaudeMcpGet,
  parseClaudeMcpList,
  parseCodexMcpList,
} from "../src/server/operations/mcp-detection.js";

const PROD_MCP_URL = "https://mcp.closedloop.ai/mcp";
const LOCAL_MCP_URL = "http://localhost:3010/mcp";

describe("normalizeMcpServerUrl", () => {
  test("normalizes trailing slashes", () => {
    assert.equal(
      normalizeMcpServerUrl("https://mcp.closedloop.ai/mcp/"),
      PROD_MCP_URL
    );
  });
});

describe("parseClaudeMcpList", () => {
  test("matches by url and returns the configured server name", () => {
    const stdout =
      "my-prod-server: https://mcp.closedloop.ai/mcp (HTTP) - ✓ Connected";
    assert.deepEqual(parseClaudeMcpList(stdout, PROD_MCP_URL), {
      name: "my-prod-server",
      url: PROD_MCP_URL,
      available: true,
    });
  });

  test("returns an unavailable match when the configured url is disconnected", () => {
    const stdout =
      "my-prod-server: https://mcp.closedloop.ai/mcp (HTTP) - ✗ Failed";
    assert.deepEqual(parseClaudeMcpList(stdout, PROD_MCP_URL), {
      name: "my-prod-server",
      url: PROD_MCP_URL,
      available: false,
    });
  });

  test("returns null when the expected url is absent", () => {
    const stdout = [
      "Checking MCP server health...",
      "",
      "plugin:context7:context7: npx -y @upstash/context7-mcp - ✓ Connected",
    ].join("\n");
    assert.equal(parseClaudeMcpList(stdout, PROD_MCP_URL), null);
  });

  test("returns null for empty input", () => {
    assert.equal(parseClaudeMcpList("", PROD_MCP_URL), null);
  });

  test("does not match a different url even if the names are similar", () => {
    const stdout =
      "closedloop-dev: http://localhost:3010/mcp (HTTP) - ✓ Connected";
    assert.equal(parseClaudeMcpList(stdout, PROD_MCP_URL), null);
  });

  test("matches the expected url in multi-line output", () => {
    const stdout = [
      "Checking MCP server health...",
      "",
      "plugin:context7:context7: npx -y @upstash/context7-mcp - ✓ Connected",
      "closedloop-dev: http://localhost:3010/mcp (HTTP) - ✓ Connected",
      "my-prod-server: https://mcp.closedloop.ai/mcp (HTTP) - ✓ Connected",
    ].join("\n");
    assert.deepEqual(parseClaudeMcpList(stdout, PROD_MCP_URL), {
      name: "my-prod-server",
      url: PROD_MCP_URL,
      available: true,
    });
  });

  test("treats trailing slashes as the same server url", () => {
    const stdout = "prod: https://mcp.closedloop.ai/mcp/ (HTTP) - ✓ Connected";
    assert.deepEqual(parseClaudeMcpList(stdout, PROD_MCP_URL), {
      name: "prod",
      url: "https://mcp.closedloop.ai/mcp/",
      available: true,
    });
  });
});

describe("parseClaudeMcpGet", () => {
  test("matches by url and returns the configured server name", () => {
    const stdout = [
      "closedloop-dev:",
      "  Scope: Local config (private to you in this project)",
      "  Status: ✓ Connected",
      "  Type: http",
      "  URL: http://localhost:3010/mcp",
    ].join("\n");

    assert.deepEqual(parseClaudeMcpGet(stdout, LOCAL_MCP_URL), {
      name: "closedloop-dev",
      url: LOCAL_MCP_URL,
      available: true,
    });
  });

  test("returns an unavailable match when the configured url is disconnected", () => {
    const stdout = [
      "closedloop-dev:",
      "  Scope: Local config (private to you in this project)",
      "  Status: ✗ Failed to connect",
      "  Type: http",
      "  URL: http://localhost:3010/mcp",
    ].join("\n");

    assert.deepEqual(parseClaudeMcpGet(stdout, LOCAL_MCP_URL), {
      name: "closedloop-dev",
      url: LOCAL_MCP_URL,
      available: false,
    });
  });

  test("returns null when the url does not match the expected server", () => {
    const stdout = [
      "closedloop:",
      "  Scope: User config (available in all your projects)",
      "  Status: ✓ Connected",
      "  Type: http",
      "  URL: https://mcp.closedloop.ai/mcp",
    ].join("\n");

    assert.equal(parseClaudeMcpGet(stdout, LOCAL_MCP_URL), null);
  });
});

describe("parseCodexMcpList", () => {
  test("matches by url and returns the configured server name", () => {
    const stdout = [
      "Name            Url                            Bearer Token Env Var  Status   Auth",
      "my-prod-server  https://mcp.closedloop.ai/mcp  -                     enabled  OAuth",
    ].join("\n");
    assert.deepEqual(parseCodexMcpList(stdout, PROD_MCP_URL), {
      name: "my-prod-server",
      url: PROD_MCP_URL,
      available: true,
    });
  });

  test("returns an unavailable match when status is disconnected", () => {
    const stdout = [
      "Name            Url                            Bearer Token Env Var  Status        Auth",
      "my-prod-server  https://mcp.closedloop.ai/mcp  -                     disconnected  OAuth",
    ].join("\n");
    assert.deepEqual(parseCodexMcpList(stdout, PROD_MCP_URL), {
      name: "my-prod-server",
      url: PROD_MCP_URL,
      available: false,
    });
  });

  test("returns null for header-only output", () => {
    const stdout =
      "Name        Url                            Bearer Token Env Var  Status   Auth";
    assert.equal(parseCodexMcpList(stdout, PROD_MCP_URL), null);
  });

  test("returns null for empty input", () => {
    assert.equal(parseCodexMcpList("", PROD_MCP_URL), null);
  });

  test("does not match a different url", () => {
    const stdout = [
      "Name            Url                                Bearer Token Env Var  Status   Auth",
      "closedloop-dev  http://localhost:3010/mcp          -                     enabled  OAuth",
    ].join("\n");
    assert.equal(parseCodexMcpList(stdout, PROD_MCP_URL), null);
  });

  test("matches a local server when the expected url is local", () => {
    const stdout = [
      "Name            Url                                Bearer Token Env Var  Status   Auth",
      "closedloop-dev  http://localhost:3010/mcp          -                     enabled  OAuth",
    ].join("\n");
    assert.deepEqual(parseCodexMcpList(stdout, LOCAL_MCP_URL), {
      name: "closedloop-dev",
      url: LOCAL_MCP_URL,
      available: true,
    });
  });
});
