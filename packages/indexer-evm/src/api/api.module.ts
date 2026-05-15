import { Module } from '@nestjs/common';
import { EndpointsController } from './endpoints.controller';
import { AgentsController } from './agents.controller';
import { CallsController } from './calls.controller';
import { DbModule } from '../db/db.module';

@Module({
  imports: [DbModule],
  controllers: [EndpointsController, AgentsController, CallsController],
})
export class ApiModule {}
