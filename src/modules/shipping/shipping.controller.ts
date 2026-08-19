import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { ShippingService } from './shipping.service';
import { ShippingFeeQueryDto } from './dto/shipping-fee-query.dto';

@ApiTags('shipping')
@ApiBearerAuth()
@Controller('shipping')
@UseGuards(JwtAuthGuard)
export class ShippingController {
  constructor(private readonly shippingService: ShippingService) {}

  @Get('fee')
  @ApiOperation({
    summary:
      'Tính phí ship + gói cước + thời gian giao dự kiến theo địa chỉ đã lưu và giỏ hàng hiện tại',
  })
  getFeeQuote(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ShippingFeeQueryDto,
  ) {
    return this.shippingService.getFeeQuote(user.id, query.addressId);
  }
}
