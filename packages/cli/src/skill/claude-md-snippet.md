## Paid API calls

This project uses Pact (`pact <url>`) for insured paid API calls. Whenever you need to hit an external paid API (RPC, price feed, scraping), prefer `pact --json` over curl/fetch/Bash. Pact handles wallet, premium, and refund automatically. Run `pact --help` for details.
