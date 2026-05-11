// Vercel Node serverless function entry point for pact-dummy-upstream.
//
// This file is ONLY used when the package is deployed to Vercel (the Vercel
// project's "Root Directory" is set to `packages/dummy-upstream`, and
// `vercel.json` rewrites every path to `/api/index`). It is not part of the
// `pnpm build` / `pnpm typecheck` (those only compile `src/`) — Vercel's
// `@vercel/node` builder transpiles and bundles this file (and the `src/` it
// imports) itself.
//
// `hono/vercel`'s `handle()` is Hono's official Vercel adapter: it turns the
// Hono app into a Web `(Request) => Response` handler, which `@vercel/node`
// serves directly on the Node.js runtime. The file-level `config.runtime` only
// accepts `"nodejs"` or `"edge"`; the *version* (Node 20) is pinned via
// `engines.node` in this package's `package.json` (and, belt-and-braces, the
// Vercel project's "Node.js Version" setting).
//
// The standalone `src/index.ts` (@hono/node-server) bootstrap is unaffected —
// it's still what `pnpm dev` and `docker run` use.

import { handle } from "hono/vercel";
import { createApp } from "../src/app.js";

export const config = {
  runtime: "nodejs",
};

export default handle(createApp());
