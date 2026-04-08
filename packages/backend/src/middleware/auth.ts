import { createHash } from "crypto";
import type { FastifyRequest, FastifyReply } from "fastify";
import { getOne } from "../db.js";

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export async function requireApiKey(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    reply.code(401).send({ error: "Missing API key" });
    return;
  }

  const key = header.slice(7);
  const hash = hashKey(key);

  const row = await getOne<{ id: string; label: string }>(
    "SELECT id, label FROM api_keys WHERE key_hash = $1",
    [hash],
  );

  if (!row) {
    reply.code(401).send({ error: "Invalid API key" });
    return;
  }

  (request as FastifyRequest & { agentId: string }).agentId = row.label;
}

export { hashKey };
