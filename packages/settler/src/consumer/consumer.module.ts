import { Module } from "@nestjs/common";
import { ConsumerService } from "./consumer.service";
import { PubSub } from "@google-cloud/pubsub";

@Module({
  providers: [
    {
      provide: PubSub,
      useFactory: () => new PubSub(),
    },
    ConsumerService,
  ],
  exports: [ConsumerService],
})
export class ConsumerModule {}
