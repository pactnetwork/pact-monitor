import { Hono } from "hono";

// TODO: implement agent wallet endpoints in Phase 2
const agentsRoute = new Hono();

agentsRoute.all("*", (c) => c.json({ error: "not implemented" }, 501));

export { agentsRoute };
