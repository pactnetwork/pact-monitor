// Tests for `pact pay coverage <id>` — the pay.sh coverage status
// lookup. HTTP layer mocked via a fetch override.

import { describe, expect, test } from "bun:test";
import { payCoverageStatusCommand } from "../src/cmd/pay-coverage.ts";

function fakeFetch(handler: (url: string) => Response | Promise<Response>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    return handler(url);
  }) as unknown as typeof fetch;
}
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("pact pay coverage <id>", () => {
  test("rejects an empty/whitespace coverage id without a round-trip", async () => {
    let hit = false;
    const env = await payCoverageStatusCommand({
      coverageId: "   ",
      facilitatorUrl: "https://f.test",
      fetchImpl: fakeFetch(() => {
        hit = true;
        return jsonResponse(200, {});
      }),
    });
    expect(hit).toBe(false);
    expect(env.status).toBe("client_error");
    const body = env.body as { error: string };
    expect(body.error).toBe("invalid_coverage_id");
  });

  test("settled coverage → ok envelope with settle_batch sig + Solscan link", async () => {
    const sig = "3xQ".repeat(20);
    const env = await payCoverageStatusCommand({
      coverageId: "cov_abc",
      facilitatorUrl: "https://f.test",
      fetchImpl: fakeFetch((url) => {
        expect(url).toBe("https://f.test/v1/coverage/cov_abc");
        return jsonResponse(200, {
          coverageId: "cov_abc",
          status: "settled",
          callId: "00000000-0000-4000-8000-000000000001",
          settleBatchSignature: sig,
        });
      }),
    });
    expect(env.status).toBe("ok");
    expect(env.meta?.coverage_status).toBe("settled");
    expect(env.meta?.settle_batch_signature).toBe(sig);
    expect(env.meta?.solscan_url).toBe(`https://solscan.io/tx/${sig}`);
    expect(env.meta?.call_id).toBe("00000000-0000-4000-8000-000000000001");
  });

  test("pending coverage → ok envelope, no settle sig yet", async () => {
    const env = await payCoverageStatusCommand({
      coverageId: "cov_pending",
      facilitatorUrl: "https://f.test",
      fetchImpl: fakeFetch(() =>
        jsonResponse(200, { coverageId: "cov_pending", status: "settlement_pending" }),
      ),
    });
    expect(env.status).toBe("ok");
    expect(env.meta?.coverage_status).toBe("settlement_pending");
    expect(env.meta?.settle_batch_signature).toBeUndefined();
    expect(env.meta?.solscan_url).toBeUndefined();
  });

  test("404 → client_error coverage_not_found", async () => {
    const env = await payCoverageStatusCommand({
      coverageId: "missing",
      facilitatorUrl: "https://f.test",
      fetchImpl: fakeFetch(() => new Response("nope", { status: 404 })),
    });
    expect(env.status).toBe("client_error");
    expect((env.body as { error: string }).error).toBe("coverage_not_found");
  });

  test("5xx → server_error envelope", async () => {
    const env = await payCoverageStatusCommand({
      coverageId: "cov_x",
      facilitatorUrl: "https://f.test",
      fetchImpl: fakeFetch(() => new Response("boom", { status: 502 })),
    });
    expect(env.status).toBe("server_error");
    expect((env.body as { error: string }).error).toBe("facilitator_error");
  });

  test("network down → discovery_unreachable envelope", async () => {
    const env = await payCoverageStatusCommand({
      coverageId: "cov_x",
      facilitatorUrl: "https://f.test",
      fetchImpl: fakeFetch(() => {
        throw new Error("ECONNREFUSED");
      }),
    });
    expect(env.status).toBe("discovery_unreachable");
    expect((env.body as { error: string }).error).toBe("facilitator_unreachable");
  });
});
