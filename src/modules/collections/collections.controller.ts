import { Controller, Get, Param } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CollectionsService } from './collections.service';

@ApiTags('collections')
@Controller('collections')
export class CollectionsController {
  constructor(private readonly collectionsService: CollectionsService) {}

  @Get('active')
  @ApiOperation({
    summary: 'Bộ sưu tập đang diễn ra để quảng bá ở trang chủ (public)',
  })
  findActive() {
    return this.collectionsService.findActive();
  }

  @Get(':slug')
  @ApiOperation({ summary: 'Chi tiết bộ sưu tập theo slug (public)' })
  findBySlug(@Param('slug') slug: string) {
    return this.collectionsService.findBySlug(slug);
  }
}
