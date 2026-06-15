// Pull the SettlementEvents the live facilitator PUBLISHED to the Pub/Sub
// emulator. This is the on-the-wire evidence of what the route computed: each
// event carries refundLamports (the capped/uncapped refund) and verdictSource.
//
// MUST be run from packages/facilitator (so @google-cloud/pubsub resolves) with
// PUBSUB_EMULATOR_HOST set. Writes the collected events to --out as JSON.
// @google-cloud/pubsub lives in packages/facilitator/node_modules (a workspace
// dep), so resolve it from there regardless of this file's location / cwd.
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const facilitatorDir = path.resolve(HERE, "../../../packages/facilitator") + "/";
const require = createRequire(pathToFileURL(facilitatorDir));
const { PubSub } = require("@google-cloud/pubsub");

function arg(name, def) { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : def; }
const project = process.env.PUBSUB_PROJECT || "pact-handtest";
const subName = arg("sub", process.env.PUBSUB_SUB || "handtest-sub");
const outFile = arg("out");
const waitMs = Number(arg("waitMs", "5000"));

const ps = new PubSub({ projectId: project });
const sub = ps.subscription(subName, { flowControl: { maxMessages: 100 } });
const events = [];
sub.on("message", (msg) => {
  let json; try { json = JSON.parse(msg.data.toString("utf8")); } catch { json = { raw: msg.data.toString("utf8") }; }
  events.push(json);
  msg.ack();
});
sub.on("error", (e) => console.error("[pull-events] sub error", e.message));

await new Promise((r) => setTimeout(r, waitMs));
await sub.close();

events.sort((a, b) => Number(a.refundLamports ?? 0) - Number(b.refundLamports ?? 0));
if (outFile) writeFileSync(outFile, JSON.stringify(events, null, 2));
console.log(`[pull-events] collected ${events.length} event(s)`);
for (const e of events) {
  console.log(`  callId=${e.callId} outcome=${e.outcome} premium=${e.premiumLamports} refund=${e.refundLamports} verdictSource=${e.verdictSource} verified=${e.verified}`);
}
process.exit(0);
