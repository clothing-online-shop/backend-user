import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { BrandsService } from './brands.service';

@ApiTags('brands')
@Controller('brands')
export class BrandsController {
  constructor(private readonly brandsService: BrandsService) {}

  @Get()
  @ApiOperation({
    summary:
      'Danh sách thương hiệu đang có sản phẩm bán (public, kèm số lượng sản phẩm)',
  })
  findAll() {
    return this.brandsService.findAllWithProductCount();
  }
}
