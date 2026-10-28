import assert from "node:assert/strict";
import { test } from "vitest";
import { validateOutboundUrlForSurface } from "../src/server/outbound-url-policy.js";

test("classifyIpv6: expanded loopback 0:0:0:0:0:0:0:1 is classified as loopback", () => {
  const decision = validateOutboundUrlForSurface(
    "loop_attachment_download",
    "https://[0:0:0:0:0:0:0:1]/file.txt"
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.diagnostics.reason, "ip_literal_not_allowed");
  assert.equal(decision.diagnostics.destinationClass, "loopback");
});

test("attachment policy: port is included in descriptor when non-default", () => {
  const decision = validateOutboundUrlForSurface(
    "loop_attachment_download",
    "https://closedloop-files.s3.us-east-1.amazonaws.com:8443/file.txt"
  );
  assert.equal(decision.diagnostics.port, "8443");
});

test("attachment policy: port is absent in descriptor when not specified", () => {
  const decision = validateOutboundUrlForSurface(
    "loop_attachment_download",
    "https://closedloop-files.s3.us-east-1.amazonaws.com/file.txt"
  );
  assert.equal(decision.diagnostics.port, undefined);
});

test("attachment policy: hostname normalization is case-insensitive", () => {
  const decision = validateOutboundUrlForSurface(
    "loop_attachment_download",
    "https://CLOSEDLOOP-FILES.S3.US-EAST-1.AMAZONAWS.COM/file.txt"
  );
  assert.equal(decision.allowed, true);
  assert.equal(
    decision.diagnostics.hostname,
    "closedloop-files.s3.us-east-1.amazonaws.com"
  );
});

test("attachment policy: IPv4 192.168.x.x is denied as private", () => {
  const decision = validateOutboundUrlForSurface(
    "loop_attachment_download",
    "https://192.168.1.1/file.txt"
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.diagnostics.reason, "private_address_not_allowed");
  assert.equal(decision.diagnostics.destinationClass, "private");
});

test("attachment policy: localhost.example.com is not loopback", () => {
  const decision = validateOutboundUrlForSurface(
    "loop_attachment_download",
    "https://localhost.example.com/file.txt"
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.diagnostics.reason, "attachment_host_not_allowed");
  assert.equal(decision.diagnostics.destinationClass, "external");
});

test("attachment policy: sub.localhost is classified as loopback", () => {
  const decision = validateOutboundUrlForSurface(
    "loop_attachment_download",
    "https://sub.localhost:3000/file.txt"
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.diagnostics.reason, "ip_literal_not_allowed");
  assert.equal(decision.diagnostics.destinationClass, "loopback");
});

test("classifyIpv6: fc prefix is classified as private", () => {
  const decision = validateOutboundUrlForSurface(
    "loop_attachment_download",
    "https://[fc00::1]/file.txt"
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.diagnostics.reason, "private_address_not_allowed");
  assert.equal(decision.diagnostics.destinationClass, "private");
});

test("classifyIpv6: fe9x prefix is classified as link_local", () => {
  const decision = validateOutboundUrlForSurface(
    "loop_attachment_download",
    "https://[fe90::1]/file.txt"
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.diagnostics.reason, "link_local_address_not_allowed");
  assert.equal(decision.diagnostics.destinationClass, "link_local");
});

// Moved out of a generic `gateway-*-coverage` bucket (ISS-9170) so these
// cases sit with the module's own suite.
test("classifyIpv4: 172.x address just below the private range (172.15) is ip_literal, not private", () => {
  const decision = validateOutboundUrlForSurface(
    "loop_attachment_download",
    "https://172.15.0.1/file.txt"
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.diagnostics.reason, "ip_literal_not_allowed");
  assert.equal(decision.diagnostics.destinationClass, "ip_literal");
});

test("classifyIpv4: 172.x address just above the private range (172.32) is ip_literal, not private", () => {
  const decision = validateOutboundUrlForSurface(
    "loop_attachment_download",
    "https://172.32.0.1/file.txt"
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.diagnostics.reason, "ip_literal_not_allowed");
  assert.equal(decision.diagnostics.destinationClass, "ip_literal");
});

test("classifyIpv4: 192.x address outside 192.168 (192.0.2.1) is ip_literal, not private", () => {
  const decision = validateOutboundUrlForSurface(
    "loop_attachment_download",
    "https://192.0.2.1/file.txt"
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.diagnostics.reason, "ip_literal_not_allowed");
  assert.equal(decision.diagnostics.destinationClass, "ip_literal");
});

test("classifyIpv4: 169.x address outside 169.254 (169.1.1.1) is ip_literal, not link-local or metadata", () => {
  const decision = validateOutboundUrlForSurface(
    "loop_attachment_download",
    "https://169.1.1.1/file.txt"
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.diagnostics.reason, "ip_literal_not_allowed");
  assert.equal(decision.diagnostics.destinationClass, "ip_literal");
});
