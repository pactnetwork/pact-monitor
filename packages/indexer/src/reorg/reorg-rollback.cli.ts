/**
 * reorg-rollback CLI — operator entrypoint for D6 §5.2 hard-reorg rollback
 * (WP-MN-04 T3).
 *
 * Usage:
 *   pnpm --filter @pact-network/indexer exec ts-node \
 *     src/reorg/reorg-rollback.cli.ts --network=<n> --call-id=<id>
 *
 * Boots the full AppModule as a standalone Nest context so it shares the
 * exact Prisma + adapter configuration the live indexer uses. Exits 0 on
 * success, 1 on failure, 2 on usage error.
 */
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../app.module";
import { ReorgService } from "./reorg.service";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const networkArg = args.find((a) => a.startsWith("--network="));
  const callIdArg = args.find((a) => a.startsWith("--call-id="));
  if (!networkArg || !callIdArg) {
    // eslint-disable-next-line no-console
    console.error(
      "Usage: reorg-rollback --network=<network> --call-id=<callId>",
    );
    process.exit(2);
  }
  const network = networkArg.replace("--network=", "").trim();
  const callId = callIdArg.replace("--call-id=", "").trim();
  if (!network || !callId) {
    // eslint-disable-next-line no-console
    console.error(
      "Usage: reorg-rollback --network=<network> --call-id=<callId>",
    );
    // eslint-disable-next-line no-console
    console.error(`Got: network="${network}" callId="${callId}"`);
    process.exit(2);
  }

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ["log", "warn", "error"],
  });
  try {
    const reorg = app.get(ReorgService);
    await reorg.rollback(network, callId);
    // eslint-disable-next-line no-console
    console.log(`OK: rolled back network=${network} callId=${callId}`);
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
