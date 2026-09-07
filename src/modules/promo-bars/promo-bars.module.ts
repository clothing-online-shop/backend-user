import { Module } from '@nestjs/common';
import { PromoBarsController } from './promo-bars.controller';
import { PromoBarsService } from './promo-bars.service';

@Module({
  controllers: [PromoBarsController],
  providers: [PromoBarsService],
})
export class PromoBarsModule {}
