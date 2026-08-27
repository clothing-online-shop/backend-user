import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PopupsService } from './popups.service';

@ApiTags('popups')
@Controller('popups')
export class PopupsController {
  constructor(private readonly popupsService: PopupsService) {}

  @Get('active')
  @ApiOperation({
    summary: 'Popup marketing đang hiển thị (public, trả null nếu không có)',
  })
  findActive() {
    return this.popupsService.findActive();
  }
}
