import { Module } from '@nestjs/common';
import { OrdersModule } from '../orders/orders.module';
import { InternalOrdersController } from './internal-orders.controller';

@Module({
  imports: [OrdersModule],
  controllers: [InternalOrdersController],
})
export class InternalModule {}
