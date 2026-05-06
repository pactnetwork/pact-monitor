import { Hono } from "hono";
import { healthRoute } from "./routes/health";
import { agentsRoute } from "./routes/agents";
import { proxyRoute } from "./routes/proxy";

type Env = {
  Bindings: {
    PACT_KV: KVNamespace;
    UPSTASH_REDIS_URL: string;
    UPSTASH_REDIS_TOKEN: string;
    RPC_URL: string;
    ENDPOINTS_RELOAD_TOKEN: string;
  };
};

const app = new Hono<Env>();

app.get("/health", healthRoute);
app.route("/v1/agents", agentsRoute);
app.all("/v1/:slug/*", proxyRoute);

export default app;
