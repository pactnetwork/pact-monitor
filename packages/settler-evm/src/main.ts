import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // Required for OnModuleDestroy: PipelineService drains the in-flight batch
  // (and the submitter's awaited FailedSettlement writes) on SIGTERM within
  // Cloud Run's 10s grace; PrismaService.$disconnect runs after.
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 8080);
}

bootstrap();
