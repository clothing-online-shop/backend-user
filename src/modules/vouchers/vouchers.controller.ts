import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { PrismaService } from '../../config/prisma.service';
import { resolveOwnedCartItems } from '../../common/utils/cart-items.util';
import { VouchersService } from './vouchers.service';
import { ValidateVoucherDto } from './dto/validate-voucher.dto';

@ApiTags('vouchers')
@ApiBearerAuth()
@Controller('vouchers')
@UseGuards(JwtAuthGuard)
export class VouchersController {
  constructor(
    private readonly vouchersService: VouchersService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('validate')
  @ApiOperation({
    summary:
      'Xem trước số tiền được giảm khi áp mã voucher cho các dòng giỏ hàng đã chọn, trước khi đặt hàng thật',
  })
  async validate(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ValidateVoucherDto,
  ) {
    const { subtotal } = await resolveOwnedCartItems(
      this.prisma,
      user.id,
      dto.cartItemIds,
    );
    const { voucher, discountAmount } =
      await this.vouchersService.validateAndCompute(
        this.prisma,
        user.id,
        dto.code,
        subtotal,
      );
    return {
      code: voucher.code,
      discountType: voucher.discountType,
      subtotal: subtotal.toNumber(),
      discountAmount: discountAmount.toNumber(),
      total: subtotal.sub(discountAmount).toNumber(),
    };
  }
}
