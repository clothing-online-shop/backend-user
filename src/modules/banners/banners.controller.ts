import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { BannersService } from './banners.service';

@ApiTags('banners')
@Controller('banners')
export class BannersController {
  constructor(private readonly bannersService: BannersService) {}

  @Get('active')
  @ApiOperation({ summary: 'Banner trang chủ đang hiển thị (public)' })
  findActive() {
    return this.bannersService.findActive();
  }
}
