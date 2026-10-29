import assert from "node:assert/strict";
import { test } from "vitest";
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

// ISS-5299: cover the 172.16-31 private branch in classifyIpv4 (line 191),
// the public-IPv4 ip_literal return (line 197), the fea/feb link-local branch
// in classifyIpv6 (line 208), and the public-IPv6 ip_literal return (line 215).

test("classifyIpv4: 172.16-31 private subnet is denied as private_address_not_allowed", () => {
  const decision = validateOutboundUrlForSurface(
    "loop_attachment_download",
    "https://172.16.100.200/file.txt"
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.diagnostics.reason, "private_address_not_allowed");
  assert.equal(decision.diagnostics.destinationClass, "private");
});

test("classifyIpv4: public IPv4 literal is denied as ip_literal_not_allowed", () => {
  const decision = validateOutboundUrlForSurface(
    "loop_attachment_download",
    "https://8.8.8.8/file.txt"
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.diagnostics.reason, "ip_literal_not_allowed");
  assert.equal(decision.diagnostics.destinationClass, "ip_literal");
});

test("classifyIpv6: fea and feb link-local prefixes are denied as link_local_address_not_allowed", () => {
  for (const ip of ["fea0::1", "feb0::1"]) {
    const decision = validateOutboundUrlForSurface(
      "loop_attachment_download",
      `https://[${ip}]/file.txt`
    );
    assert.equal(decision.allowed, false, ip);
    assert.equal(
      decision.diagnostics.reason,
      "link_local_address_not_allowed",
      ip
    );
    assert.equal(decision.diagnostics.destinationClass, "link_local", ip);
  }
});

test("classifyIpv6: public IPv6 literal is denied as ip_literal_not_allowed", () => {
  const decision = validateOutboundUrlForSurface(
    "loop_attachment_download",
    "https://[2001:db8::1]/file.txt"
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.diagnostics.reason, "ip_literal_not_allowed");
  assert.equal(decision.diagnostics.destinationClass, "ip_literal");
});
