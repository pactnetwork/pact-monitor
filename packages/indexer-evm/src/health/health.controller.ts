import { Controller, Get } from '@nestjs/common';
import { PrismaService } from '../db/prisma.service';
import { LogReaderService } from '../reader/log-reader.service';

@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reader: LogReaderService,
  ) {}

  @Get()
  async check() {
    const cursor = await this.prisma.indexerCursor.findUnique({
      where: { id: 'pactcore' },
    });
    const cursorBlock = cursor?.lastBlock ?? null;
    const lastScanned = this.reader.lastProcessed;
    return {
      status: 'ok',
      cursorBlock: cursorBlock === null ? null : cursorBlock.toString(),
      lastScanned: lastScanned.toString(),
    };
  }
}
