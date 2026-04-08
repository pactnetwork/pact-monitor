import "dotenv/config";
import { randomBytes } from "crypto";
import { initDb, query, pool } from "../db.js";
import { hashKey } from "../middleware/auth.js";

const label = process.argv[2] || "default";
const key = `pact_${randomBytes(24).toString("hex")}`;
const hash = hashKey(key);

await initDb();
await query("INSERT INTO api_keys (key_hash, label) VALUES ($1, $2)", [hash, label]);
await pool.end();

console.log(`API key generated for "${label}":`);
console.log(key);
console.log("\nStore this key securely — it cannot be retrieved later.");
