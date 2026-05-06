import {
  Controller,
  Get,
  NotFoundException,
  Param,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Controller("api/calls")
export class CallsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get(":id")
  async getCall(@Param("id") callId: string) {
    const call = await this.prisma.call.findUnique({ where: { callId } });
    if (!call) throw new NotFoundException(`Call not found: ${callId}`);
    return call;
  }
}
