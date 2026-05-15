// Live env binding. Re-exports the schema/parser from env-schema (which is
// side-effect-free so tests can import parseEnv without the eager parse).

export { parseEnv, type EnvType } from "./env-schema.js";
import { parseEnv } from "./env-schema.js";

export const env = parseEnv();
