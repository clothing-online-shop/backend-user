import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ColorsService } from './colors.service';

@ApiTags('colors')
@Controller('colors')
export class ColorsController {
  constructor(private readonly colorsService: ColorsService) {}

  @Get()
  @ApiOperation({
    summary:
      'Danh sách màu đang có sản phẩm bán (public, kèm mã hex để hiển thị swatch)',
  })
  findAll() {
    return this.colorsService.findAllForStorefront();
  }
}
