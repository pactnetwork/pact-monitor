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
| `x402-success`   | Synthesized from pay 0.16.0 binary string table.                | Hosted sandbox debugger.pay.sh does not expose an open x402 route; this snapshot follows the documented format pay emits on the x402 auto-pay path. |

If pay's output format drifts, re-capture against the same commands and
update the assertions in `pay-classifier.test.ts`.
