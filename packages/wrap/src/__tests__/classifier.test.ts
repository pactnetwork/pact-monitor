import { describe, it, expect } from "vitest";
import {
  defaultClassifier,
  composeWithDefault,
  type ClassifierInput,
} from "../classifier";

const cfg = {
  sla_latency_ms: 500,
  flat_premium_lamports: 1_000n,
  imputed_cost_lamports: 10_000n,
};

function input(
  status: number | null,
  latencyMs: number,
  body: string = "",
): ClassifierInput {
  return {
    response: status === null ? null : new Response(body, { status }),
    latencyMs,
    endpointConfig: cfg,
  };
}

describe("defaultClassifier", () => {
  it("2xx within sla → ok, premium=flat, refund=0", () => {
    const r = defaultClassifier.classify(input(200, 100));
    expect(r.outcome).toBe("ok");
    expect(r.premium).toBe(1_000n);
    expect(r.refund).toBe(0n);
  });

  it("2xx exceeding sla → latency_breach, premium=flat, refund=imputed", () => {
    const r = defaultClassifier.classify(input(200, 600));
    expect(r.outcome).toBe("latency_breach");
    expect(r.premium).toBe(1_000n);
    expect(r.refund).toBe(10_000n);
  });

  it("2xx exactly at sla → ok (boundary)", () => {
    const r = defaultClassifier.classify(input(200, 500));
    expect(r.outcome).toBe("ok");
  });

  it.each([500, 502, 503, 504, 599])(
    "%i → server_error, premium=flat, refund=imputed",
    (status) => {
      const r = defaultClassifier.classify(input(status, 50));
      expect(r.outcome).toBe("server_error");
      expect(r.premium).toBe(1_000n);
      expect(r.refund).toBe(10_000n);
    },
  );

  it("429 → client_error, premium=0, refund=0", () => {
    const r = defaultClassifier.classify(input(429, 50));
    expect(r.outcome).toBe("client_error");
    expect(r.premium).toBe(0n);
    expect(r.refund).toBe(0n);
  });

  it.each([400, 401, 403, 404, 422, 451])(
    "%i (other 4xx) → client_error, premium=0, refund=0",
    (status) => {
      const r = defaultClassifier.classify(input(status, 50));
      expect(r.outcome).toBe("client_error");
      expect(r.premium).toBe(0n);
      expect(r.refund).toBe(0n);
    },
  );

  it("network error (response=null) → network_error, premium=flat, refund=imputed", () => {
    const r = defaultClassifier.classify(input(null, 0));
    expect(r.outcome).toBe("network_error");
    expect(r.premium).toBe(1_000n);
    expect(r.refund).toBe(10_000n);
  });

  it("3xx → ok (no refund)", () => {
    const r = defaultClassifier.classify(input(301, 10));
    expect(r.outcome).toBe("ok");
    expect(r.premium).toBe(1_000n);
    expect(r.refund).toBe(0n);
  });
});

describe("composeWithDefault", () => {
  it("uses plugin result when plugin returns non-null", () => {
    const plugin = composeWithDefault(() => ({
      outcome: "server_error",
      premium: 42n,
      refund: 99n,
    }));
    const r = plugin.classify(input(200, 10));
    expect(r.outcome).toBe("server_error");
    expect(r.premium).toBe(42n);
    expect(r.refund).toBe(99n);
  });

  it("falls through to default when plugin returns null", () => {
    const plugin = composeWithDefault(() => null);
    const r = plugin.classify(input(200, 10));
    expect(r.outcome).toBe("ok");
    expect(r.premium).toBe(1_000n);
  });

  it("plugin can inspect the response", () => {
    const plugin = composeWithDefault((i) => {
      // Synthetic example: treat any 200 with body 'fail' as server_error.
      // Note: response.text() is async; in real code plugins should
      // pre-resolve via .clone().text() outside the hot path. Here we use
      // a synchronous body marker via headers for the test.
      if (i.response?.headers.get("x-fake-fail") === "1") {
        return {
          outcome: "server_error",
          premium: i.endpointConfig.flat_premium_lamports,
          refund: i.endpointConfig.imputed_cost_lamports,
        };
      }
      return null;
    });
    const r1 = plugin.classify({
      response: new Response("", { status: 200, headers: { "x-fake-fail": "1" } }),
      latencyMs: 10,
      endpointConfig: cfg,
    });
    expect(r1.outcome).toBe("server_error");

    const r2 = plugin.classify({
      response: new Response("", { status: 200 }),
      latencyMs: 10,
      endpointConfig: cfg,
    });
    expect(r2.outcome).toBe("ok");
  });
});
