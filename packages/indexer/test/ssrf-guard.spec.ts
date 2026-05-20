import {
  assertSafeWebhookUrl,
  isUnsafeIp,
  SsrfRejectedError,
} from "../src/refund-delivery/ssrf-guard";

describe("isUnsafeIp", () => {
  const unsafe = [
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // cloud metadata
    "0.0.0.0",
    "100.64.0.1", // CGNAT
    "224.0.0.1", // multicast
    "::1",
    "::",
    "fc00::1", // ULA
    "fd12:3456::1", // ULA
    "fe80::1", // link-local
    "::ffff:127.0.0.1", // IPv4-mapped loopback
    "::ffff:169.254.169.254",
    "999.1.1.1", // malformed -> reject
  ];
  const safe = ["8.8.8.8", "1.1.1.1", "203.0.113.10", "2606:4700::1111"];

  for (const ip of unsafe) {
    it(`rejects ${ip}`, () => expect(isUnsafeIp(ip)).toBe(true));
  }
  for (const ip of safe) {
    it(`allows ${ip}`, () => expect(isUnsafeIp(ip)).toBe(false));
  }
});

describe("assertSafeWebhookUrl", () => {
  it("accepts a plain https URL", () => {
    expect(assertSafeWebhookUrl("https://hooks.example.com/pact").hostname).toBe(
      "hooks.example.com",
    );
  });
  it.each([
    ["http://hooks.example.com", "must be https"],
    ["https://u:p@hooks.example.com", "credentials"],
    ["https://hooks.example.com:8080", "port"],
    ["https://127.0.0.1", "private/loopback"],
    ["not a url", "unparseable"],
  ])("rejects %s", (url) => {
    expect(() => assertSafeWebhookUrl(url)).toThrow(SsrfRejectedError);
  });
});
