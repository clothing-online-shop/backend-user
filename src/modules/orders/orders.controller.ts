import { Controller } from '@nestjs/common';
import { OrdersService } from './orders.service';

// TODO: implement orders endpoints in a later sprint
@Controller('orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}
}
