import { describe, it, expect } from "vitest";
import { canonicalHostname } from "../hostname.js";

describe("canonicalHostname", () => {
  it("strips scheme", () => {
    expect(canonicalHostname("https://api.helius.xyz")).toBe("api.helius.xyz");
    expect(canonicalHostname("http://api.helius.xyz")).toBe("api.helius.xyz");
  });

  it("adds an implicit scheme for bare hosts", () => {
    expect(canonicalHostname("api.helius.xyz")).toBe("api.helius.xyz");
  });

  it("lowercases", () => {
    expect(canonicalHostname("API.Helius.XYZ")).toBe("api.helius.xyz");
  });

  it("strips path and query", () => {
    expect(canonicalHostname("https://api.helius.xyz/v0/addresses/foo?x=1")).toBe(
      "api.helius.xyz",
    );
  });

  it("strips userinfo and port", () => {
    expect(canonicalHostname("https://user:pass@api.helius.xyz:443/v0")).toBe(
      "api.helius.xyz",
    );
  });

  it("strips trailing FQDN dots so foo.com. === foo.com", () => {
    expect(canonicalHostname("https://foo.com./x")).toBe("foo.com");
    expect(canonicalHostname("foo.com.")).toBe("foo.com");
  });

  it("round-trips a full URL down to the bare host", () => {
    const once = canonicalHostname("https://api.helius.xyz/v0/foo");
    expect(canonicalHostname(once)).toBe(once);
  });

  it("throws on empty / whitespace input", () => {
    expect(() => canonicalHostname("")).toThrow(/must not be empty/);
    expect(() => canonicalHostname("   ")).toThrow(/must not be empty/);
  });

  it("throws on a non-string input", () => {
    // @ts-expect-error deliberate misuse
    expect(() => canonicalHostname(42)).toThrow(/must be a string/);
  });

  it("throws on an unparseable hostname", () => {
    expect(() => canonicalHostname("http://")).toThrow(/invalid hostname/);
  });

  it("maps a dummy demo URL to its bare host", () => {
    expect(
      canonicalHostname("https://dummy.pactnetwork.io/quote/AAPL?fail=1"),
    ).toBe("dummy.pactnetwork.io");
  });
});
