# pay 0.16.0 stream fixtures

Captured (or, where the live path is gated, synthesized from binary
strings) for the `pact pay` classifier regression suite. Each pair is a
verbatim `.stdout` + `.stderr` snapshot from a `pay <args>` invocation;
the test harness in `packages/cli/test/pay-classifier.test.ts` loads
them, feeds the bytes to `classifyPayResult`, and asserts the verdict.

| Fixture          | Source                                                          | Notes                                                                                                       |
| ---------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `mpp-success`    | `pay -v --sandbox curl https://debugger.pay.sh/mpp/quote/AAPL` | Real capture, 2026-05-11. Contains ANSI escapes from pay's tracing layer.                                   |
| `curl-non402`    | `pay -v --sandbox curl https://api.github.com/zen`             | Real capture, 2026-05-11. Free passthrough — pay emits nothing on stderr.                                   |
| `x402-success`   | Synthesized from pay 0.16.0 binary string table.                | Hosted sandbox debugger.pay.sh does not expose an open x402 route; this snapshot follows the legacy `402 Payment Required (x402) — N USDC` body-line format. |
| `x402-buildline-success` | Synthesized — pay 0.16.0 x402 auto-pay (`pay curl '<url>?x402=1'`), mainnet. | The format `pay` 0.13.0/0.16.0 actually emits on the hosted x402 path: a `Detected x402 challenge (Solana)` line + `Building x402 payment amount=<base-units> currency=<mint> cluster=… recipient=<merchant-pk> signer=<agent-pk>`. `pay curl` echoes the final 200 body, not the 402 challenge — so the amount/asset/payee come from this stderr line, not the body. stdout carries pact's injected `[pact-http-status=200]` marker (curl `-w`). |
| `x402-buildline-013` | Synthesized — pay 0.13.0 plain (non-tracing) variant of the same x402 build line. | Same fields as above without the ANSI tracing-layer decoration; the classifier must parse both. |
| `x402-buildline-5xx` | Synthesized — x402 payment settled, upstream then returns 503. | Exercises the `server_error → refund` path via `pact pay curl`: stdout has `[pact-http-status=503]` from curl's `-w`, so the classifier sees the 5xx even though plain curl exits 0. |

If pay's output format drifts, re-capture against the same commands and
update the assertions in `pay-classifier.test.ts`.
