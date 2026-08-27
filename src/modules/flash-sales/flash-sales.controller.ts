import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { FlashSalesService } from './flash-sales.service';

@ApiTags('flash-sales')
@Controller('flash-sales')
export class FlashSalesController {
  constructor(private readonly flashSalesService: FlashSalesService) {}

  @Get('active')
  @ApiOperation({
    summary:
      'Đợt Flash Sale đang diễn ra (public, gom sản phẩm theo biến thể, trả null nếu không có)',
  })
  findActive() {
    return this.flashSalesService.findActive();
  }
}
