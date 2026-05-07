import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // Required for OnModuleDestroy lifecycle hooks (PipelineService drains
  // in-flight batches on SIGTERM via Cloud Run's 10s grace window).
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 8080);
}

bootstrap();
