import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { OrdersService } from './orders.service';
import { CreateOrderDto } from './dto/create-order.dto';

@ApiTags('orders')
@ApiBearerAuth()
@Controller('orders')
@UseGuards(JwtAuthGuard)
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Post()
  @ApiOperation({
    summary:
      'Tạo đơn hàng từ giỏ hàng — sinh mã đơn, snapshot giá/thông tin sản phẩm, trừ tồn kho, đặt trạng thái Chờ xác nhận, ghi lịch sử trạng thái',
  })
  createOrder(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateOrderDto,
  ) {
    return this.ordersService.createOrder(user.id, dto);
  }

  @Get(':orderCode')
  @ApiOperation({
    summary:
      'Lấy chi tiết đơn hàng theo mã đơn — dùng cho trang cảm ơn/theo dõi đơn, chỉ trả về nếu đơn thuộc về user hiện tại',
  })
  getOrderByCode(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderCode') orderCode: string,
  ) {
    return this.ordersService.getOrderByCode(user.id, orderCode);
  }
}
