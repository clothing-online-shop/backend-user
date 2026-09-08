import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PromoBarsService } from './promo-bars.service';

@ApiTags('promo-bars')
@Controller('promo-bars')
export class PromoBarsController {
  constructor(private readonly promoBarsService: PromoBarsService) {}

  @Get('active')
  @ApiOperation({
    summary:
      'Thanh khuyến mãi header đang hiển thị (public, trả null nếu không có)',
  })
  findActive() {
    return this.promoBarsService.findActive();
  }
}
