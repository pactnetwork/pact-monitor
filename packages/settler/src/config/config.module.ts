import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { SecretLoaderService } from "./secret-loader.service";

@Module({
  imports: [ConfigModule],
  providers: [SecretLoaderService],
  exports: [SecretLoaderService],
})
export class AppConfigModule {}
