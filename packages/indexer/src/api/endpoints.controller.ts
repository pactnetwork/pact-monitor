import {
  Controller,
  Get,
  NotFoundException,
  Param,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Controller("api/endpoints")
export class EndpointsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async listEndpoints() {
    return this.prisma.endpoint.findMany({
      orderBy: { registeredAt: "asc" },
    });
  }

  @Get(":slug")
  async getEndpoint(@Param("slug") slug: string) {
    const endpoint = await this.prisma.endpoint.findUnique({
      where: { slug },
    });
    if (!endpoint) throw new NotFoundException(`Endpoint not found: ${slug}`);
    return endpoint;
  }
}
