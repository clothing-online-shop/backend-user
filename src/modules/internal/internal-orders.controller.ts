import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { ApiExcludeController, ApiOperation, ApiTags } from '@nestjs/swagger';
import { InternalApiKeyGuard } from '../../common/guards/internal-api-key.guard';
import { OrdersService } from '../orders/orders.service';
import { NotifyOrderStatusDto } from './dto/notify-order-status.dto';

// Endpoint server-to-server (backend-cms gọi sang), không dành cho FE — loại khỏi Swagger
// công khai bằng ApiExcludeController thay vì chỉ ẩn qua guard.
@ApiTags('internal')
@ApiExcludeController()
@Controller('internal/orders')
@UseGuards(InternalApiKeyGuard)
export class InternalOrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Post(':orderCode/status-notification')
  @ApiOperation({
    summary:
      'Gửi email báo khách hàng khi backend-cms đổi trạng thái đơn — chỉ gọi nội bộ giữa 2 backend',
  })
  notifyStatus(
    @Param('orderCode') orderCode: string,
    @Body() dto: NotifyOrderStatusDto,
  ) {
    return this.ordersService.notifyStatusChange(
      orderCode,
      dto.status,
      dto.note ?? null,
    );
  }
}
