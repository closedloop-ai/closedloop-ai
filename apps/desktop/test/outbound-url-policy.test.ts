import assert from "node:assert/strict";
import test from "node:test";
import { validateOutboundUrlForSurface } from "../src/server/outbound-url-policy.js";

test("attachment policy allows only current S3 virtual-hosted HTTPS form", () => {
  const decision = validateOutboundUrlForSurface(
    "loop_attachment_download",
    "https://closedloop-files.s3.us-east-1.amazonaws.com/path/to/object.txt?X-Amz-Credential=secret"
  );

  assert.equal(decision.allowed, true);
  assert.equal(decision.diagnostics.reason, "allowed");
  assert.equal(decision.diagnostics.destinationClass, "s3_virtual_hosted");
  assert.equal(
    decision.diagnostics.hostname,
    "closedloop-files.s3.us-east-1.amazonaws.com"
  );
});

test("support upload policy allows only current S3 virtual-hosted HTTPS form", () => {
  const decision = validateOutboundUrlForSurface(
    "loop_support_upload",
    "https://closedloop-files.s3.us-east-1.amazonaws.com/path/to/object.txt?X-Amz-Credential=secret"
  );

  assert.equal(decision.allowed, true);
  assert.equal(decision.diagnostics.surface, "loop_support_upload");
  assert.equal(decision.diagnostics.reason, "allowed");
  assert.equal(decision.diagnostics.destinationClass, "s3_virtual_hosted");
});

test("attachment policy denies unsafe attachment URL variants", () => {
  const cases: Array<{
    url: string;
    reason: string;
    destinationClass?: string;
  }> = [
    { url: "not a url", reason: "invalid_url" },
    {
      url: "http://closedloop-files.s3.us-east-1.amazonaws.com/file.txt",
      reason: "unsupported_protocol",
    },
    {
      url: "https://user:pass@closedloop-files.s3.us-east-1.amazonaws.com/file.txt",
      reason: "credentialed_url",
    },
    {
      url: "https://example.com/file.txt",
      reason: "attachment_host_not_allowed",
    },
    {
      url: "https://s3.us-east-1.amazonaws.com/closedloop-files/file.txt",
      reason: "path_style_s3_not_allowed",
      destinationClass: "s3_path_style",
    },
    {
      url: "https://10.0.0.1/file.txt",
      reason: "private_address_not_allowed",
      destinationClass: "private",
    },
    {
      url: "https://169.254.1.2/file.txt",
      reason: "link_local_address_not_allowed",
      destinationClass: "link_local",
    },
    {
      url: "https://169.254.169.254/latest/meta-data",
      reason: "metadata_address_not_allowed",
      destinationClass: "metadata",
    },
    {
      url: "https://127.0.0.1/file.txt",
      reason: "ip_literal_not_allowed",
      destinationClass: "loopback",
    },
    {
      url: "https://[::1]/file.txt",
      reason: "ip_literal_not_allowed",
      destinationClass: "loopback",
    },
    {
      url: "https://[fe80::1]/file.txt",
      reason: "link_local_address_not_allowed",
      destinationClass: "link_local",
    },
    {
      url: "https://[fd00::1]/file.txt",
      reason: "private_address_not_allowed",
      destinationClass: "private",
    },
  ];

  for (const testCase of cases) {
    const decision = validateOutboundUrlForSurface(
      "loop_attachment_download",
      testCase.url
    );
    assert.equal(decision.allowed, false, testCase.url);
    assert.equal(decision.diagnostics.reason, testCase.reason, testCase.url);
    if (testCase.destinationClass) {
      assert.equal(
        decision.diagnostics.destinationClass,
        testCase.destinationClass,
        testCase.url
      );
    }
  }
});

test("support upload policy denies unsafe URL variants", () => {
  const denied = [
    "http://closedloop-files.s3.us-east-1.amazonaws.com/file.txt",
    "https://user:pass@closedloop-files.s3.us-east-1.amazonaws.com/file.txt",
    "https://example.com/file.txt",
    "https://s3.us-east-1.amazonaws.com/closedloop-files/file.txt",
    "https://10.0.0.1/file.txt",
    "https://169.254.169.254/latest/meta-data",
    "https://127.0.0.1/file.txt",
  ];

  for (const url of denied) {
    const decision = validateOutboundUrlForSurface("loop_support_upload", url);
    assert.equal(decision.allowed, false, url);
    assert.equal(decision.diagnostics.surface, "loop_support_upload");
  }
});

test("deploy health policy allows loopback and localhost destinations only", () => {
  const allowed = [
    "http://localhost:3000/",
    "https://app.localhost:3000/health",
    "http://127.0.0.1:5173/",
    "http://127.42.0.1:5173/",
    "http://[::1]:3000/",
  ];

  for (const url of allowed) {
    const decision = validateOutboundUrlForSurface("deploy_health_check", url);
    assert.equal(decision.allowed, true, url);
    assert.equal(decision.diagnostics.destinationClass, "loopback", url);
    assert.equal(decision.diagnostics.reason, "allowed", url);
  }
});

test("deploy health policy denies external and private destinations", () => {
  const denied = [
    "https://example.com/",
    "http://10.0.0.1/",
    "http://192.168.1.10/",
    "http://169.254.169.254/latest/meta-data",
    "http://[fe80::1]/",
    "ftp://localhost:3000/",
  ];

  for (const url of denied) {
    const decision = validateOutboundUrlForSurface("deploy_health_check", url);
    assert.equal(decision.allowed, false, url);
  }
});

test("policy descriptors exclude URL path, query, and credentials", () => {
  const decision = validateOutboundUrlForSurface(
    "loop_attachment_download",
    "https://bucket.s3.us-east-1.amazonaws.com/users/123/report.txt?X-Amz-Signature=secret-token"
  );

  const serialized = JSON.stringify(decision.diagnostics);
  assert.equal(serialized.includes("users/123"), false);
  assert.equal(serialized.includes("X-Amz-Signature"), false);
  assert.equal(serialized.includes("secret-token"), false);
  assert.equal(serialized.includes("report.txt"), false);
});
