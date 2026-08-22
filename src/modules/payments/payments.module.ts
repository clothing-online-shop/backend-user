import { Module } from '@nestjs/common';
import { VnpayModule } from '../../common/vnpay/vnpay.module';
import { OrdersModule } from '../orders/orders.module';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

@Module({
  imports: [VnpayModule, OrdersModule],
  controllers: [PaymentsController],
  providers: [PaymentsService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
