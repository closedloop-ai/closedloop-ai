import { afterEach, expect, test, vi } from "vitest";
import { getStatus, RdsCaBundleStatus } from "./generate-rds-ca-bundle";
import { AWS_RDS_CA_BUNDLE } from "./rds-ca-bundle";

afterEach(() => {
  vi.unstubAllGlobals();
});

// Self-signed test certificate (CN=Not RDS Test), generated locally with
// `openssl req -x509 -newkey rsa:2048 -nodes -subj "/CN=Not RDS Test/O=ExampleCorp"`
// purely as fixture data for X509Certificate parsing — never fetched, never a
// real CA. Appended to the genuine embedded bundle so the combined PEM still
// clears MIN_EXPECTED_CERTS before the per-certificate RDS-subject check runs.
const NON_RDS_CERT = `-----BEGIN CERTIFICATE-----
MIIDOjCCAiKgAwIBAgITfmy9uVnGqDjqfAkfrY4xeN5FRzANBgkqhkiG9w0BAQsF
ADAtMRUwEwYDVQQDDAxOb3QgUkRTIFRlc3QxFDASBgNVBAoMC0V4YW1wbGVDb3Jw
MB4XDTI2MDkyODE0NTAzMloXDTM2MDkyNTE0NTAzMlowLTEVMBMGA1UEAwwMTm90
IFJEUyBUZXN0MRQwEgYDVQQKDAtFeGFtcGxlQ29ycDCCASIwDQYJKoZIhvcNAQEB
BQADggEPADCCAQoCggEBALmqZc7I3Oz2fR0jozK34JQPy+nyJ7jiHz2kutBhFOr1
q26CSwPDncVbDZYmc+CO0SLEjnVEGayIfW87lYO/4GE4x+UhK/riIU/O3fvIW50B
ByyVCNF6+JbDaoo154BF4wucplH5peLjmCjoP4QgbJSqhxoAwbIiAcRtANZsUa8C
cYons/3gGWRvX7Hk21qd0fo10toSmnO1HiA9uo0Rrk9XQByEStT0xjy/GwOEd9qe
/Wp/n0nR1DprQx9QXGpJX+0xV5o0xjGD38zWYEBhPgbjuo+TpiqZpJhbrEsOtcjV
zTJBEaLAt4RNoswmobGkAVOTtCdIA1rKUnE1mY5ZvVECAwEAAaNTMFEwHQYDVR0O
BBYEFKWQArvAkEV7Wa4L4p2wpS0uPX5NMB8GA1UdIwQYMBaAFKWQArvAkEV7Wa4L
4p2wpS0uPX5NMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBADDP
uj5BigsB7PrNwx6eId0/PSCLGmBs6ZMj1LvdOAjLYyiNiiIrBiUY0uS0nPlvQF3y
hDWBWv0pws8F7TenVZPpDPXE09iqfzFcxWGyejZUQQ8z/LiPFHq7FICfkITBuR1d
4DK+5j71a4C9c/sFcGqtvBZ6WQVQZqE70asQNiZnAhpAfyxpq52YHhI3oFf8GnTK
5tnjQHXjI+bJFqICz3rT82HJT7qeANbP+Ra/OGL4l+BCHyFl0BNisGA1r7wHbzfO
UMUKOkTN9EALd+4MPatcGkoNzDc4kW6agwpmEQSrn6dcAgu4482kdoppCpVsU1BR
ZxVwHAxwsAJnQ4+WwE8=
-----END CERTIFICATE-----`;

test("RDS CA status rejects a bundle carrying a non-RDS certificate", async () => {
  vi.stubGlobal(
    "fetch",
    async () => new Response(`${AWS_RDS_CA_BUNDLE}\n${NON_RDS_CERT}`)
  );

  const status = await getStatus();

  expect(status.status).toBe(RdsCaBundleStatus.InvalidBundle);
  expect(status.message).toContain("Non-RDS certificate in bundle");
  expect(status.message).toContain("CN=Not RDS Test");
});
