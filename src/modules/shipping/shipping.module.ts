import { Module } from '@nestjs/common';
import { ShippingController } from './shipping.controller';
import { ShippingService } from './shipping.service';
import { GhnModule } from '../../common/ghn/ghn.module';

@Module({
  imports: [GhnModule],
  controllers: [ShippingController],
  providers: [ShippingService],
})
export class ShippingModule {}
