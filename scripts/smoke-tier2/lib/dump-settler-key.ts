/**
 * Helper — dump the settler keypair as a base58 string for env-var injection
 * into the settler binary. Used by 04-run-stack.sh.
 */
import bs58 from "bs58";
import { SETTLEMENT_AUTHORITY_KEYPAIR } from "./paths";
import { readKeypair } from "./keys";

const kp = readKeypair(SETTLEMENT_AUTHORITY_KEYPAIR);
process.stdout.write(bs58.encode(kp.secretKey));
