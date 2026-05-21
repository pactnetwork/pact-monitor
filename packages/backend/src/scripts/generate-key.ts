import "dotenv/config";
import { randomBytes } from "crypto";
import { initDb, query, pool } from "../db.js";
import { hashKey } from "../middleware/auth.js";

type Role = "agent" | "merchant" | "partner";
const VALID_ROLES: readonly Role[] = ["agent", "merchant", "partner"] as const;

const args = process.argv.slice(2);
const label = args[0] || "default";

const pkIdx = args.indexOf("--agent-pubkey");
const agentPubkey = pkIdx >= 0 ? args[pkIdx + 1] : null;
if (pkIdx >= 0 && agentPubkey === undefined) {
  console.error("error: --agent-pubkey flag requires a value");
  process.exit(1);
}

const roleIdx = args.indexOf("--role");
const roleArg = roleIdx >= 0 ? args[roleIdx + 1] : "agent";
if (roleIdx >= 0 && roleArg === undefined) {
  console.error("error: --role flag requires a value");
  process.exit(1);
}
if (!VALID_ROLES.includes(roleArg as Role)) {
  console.error(
    `error: --role must be one of ${VALID_ROLES.join(", ")} (got ${JSON.stringify(roleArg)})`,
  );
  process.exit(1);
}
const role = roleArg as Role;

const key = `pact_${randomBytes(24).toString("hex")}`;
const hash = hashKey(key);

await initDb();
await query(
  "INSERT INTO api_keys (key_hash, label, agent_pubkey, role) VALUES ($1, $2, $3, $4)",
  [hash, label, agentPubkey, role],
);
await pool.end();

console.log(`API key generated for "${label}" (role=${role}):`);
console.log(key);
if (agentPubkey) {
  console.log(`Bound to ${role === "merchant" ? "merchant" : "agent"} pubkey: ${agentPubkey}`);
} else {
  console.log("WARNING: no --agent-pubkey given. On-chain claim submission will be skipped for this key.");
}
if (role === "merchant") {
  console.log(
    "\nREMINDER: register this merchant's hostname + endpoint pricing by calling\n" +
      "  POST /api/v1/endpoint/register\n" +
      "Ops review (manual DNS proof) is required before the endpoint becomes active.",
  );
}
console.log("\nStore this key securely — it cannot be retrieved later.");
