import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

async function bootstrap() {
  // rawBody: true so AgentSignatureGuard can hash the exact request bytes
  // (the webhook-registration signature is over sha256(raw body), matching
  // the market-proxy contract — JSON re-serialization would change the hash).
  const app = await NestFactory.create(AppModule, { rawBody: true });
  await app.listen(process.env.PORT ?? 3001);
}

bootstrap();
