// Vercel Node serverless function entry point for pact-dummy-upstream.
//
// Adapts the Hono app to a Node http handler via @hono/node-server's
// `getRequestListener` — the `(IncomingMessage, ServerResponse)` shape
// Vercel's @vercel/node runtime serves natively. (We tried `hono/vercel`'s
// `handle()` first; the deployed Node-runtime function 500'd on every request
// with FUNCTION_INVOCATION_FAILED, so we use the node-server request listener,
// which is already a dependency.)
//
// Only used on Vercel — `pnpm dev` / `docker run` still use the standalone
// `src/index.ts` (@hono/node-server `serve()`) bootstrap, untouched.

import type { IncomingMessage, ServerResponse } from "node:http";
import { getRequestListener } from "@hono/node-server";
import { createApp } from "../src/app.js";

export const config = {
  runtime: "nodejs",
};

const listener = getRequestListener(createApp().fetch);

export default function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  return listener(req, res);
}
