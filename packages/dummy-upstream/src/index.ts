import { serve } from "@hono/node-server";
import { createApp } from "./app.js";

const app = createApp();
const port = parseInt(process.env.PORT ?? "8080", 10);

serve({ fetch: app.fetch, port });
console.log(`pact-dummy-upstream listening on :${port}`);
