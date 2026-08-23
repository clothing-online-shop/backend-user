import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { normalizeIpAddr } from '../../common/utils/ip.util';
import { PaymentsService } from './payments.service';

@ApiTags('payments')
@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post(':orderId/vnpay')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary:
      'Tạo link thanh toán VNPay cho 1 đơn hàng (tạo mới hoặc thanh toán lại)',
  })
  initiateVnpay(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId') orderId: string,
    @Req() req: Request,
  ) {
    const ipAddr = normalizeIpAddr(
      req.ip ?? req.socket.remoteAddress ?? '127.0.0.1',
    );
    return this.paymentsService.initiateVnpay(user.id, orderId, ipAddr);
  }

  @Post(':orderId/bank-transfer')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary: 'Lấy thông tin chuyển khoản ngân hàng cho 1 đơn hàng',
  })
  initiateBankTransfer(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId') orderId: string,
  ) {
    return this.paymentsService.initiateBankTransfer(user.id, orderId);
  }

  // Public — trình duyệt khách redirect về từ VNPay, không mang Bearer token.
  @Get('vnpay/return')
  @ApiOperation({
    summary: 'FE gọi để verify + hiển thị kết quả sau khi VNPay redirect về',
  })
  verifyReturn(@Query() query: Record<string, string>) {
    return this.paymentsService.verifyVnpayReturn(query);
  }

  // Public — VNPay gọi server-to-server (IPN), không mang Bearer token.
  @Post('vnpay/ipn')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'VNPay IPN — nguồn xác thực chính cho kết quả thanh toán',
  })
  handleIpn(@Query() query: Record<string, string>) {
    return this.paymentsService.handleVnpayIpn(query);
  }
}
