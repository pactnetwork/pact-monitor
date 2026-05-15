import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  // Required for BeforeApplicationShutdown: LogReaderService stops the poll
  // loop + drains its in-flight block `$transaction` on SIGTERM (Cloud Run
  // 10s grace) BEFORE PrismaService.$disconnect (onModuleDestroy).
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3001);
}

bootstrap();
