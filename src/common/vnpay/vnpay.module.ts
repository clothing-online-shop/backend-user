import { Module } from '@nestjs/common';
import { VnpayClient } from './vnpay-client.service';

@Module({
  providers: [VnpayClient],
  exports: [VnpayClient],
})
export class VnpayModule {}
