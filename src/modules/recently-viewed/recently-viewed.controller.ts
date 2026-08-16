import {
  Body,
  Controller,
  Get,
  Headers,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { OptionalJwtAuthGuard } from '../../common/guards/optional-jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { RecentlyViewedService } from './recently-viewed.service';
import { RecordViewDto } from './dto/record-view.dto';

@ApiTags('recently-viewed')
@ApiHeader({
  name: 'X-Guest-Id',
  required: false,
  description:
    'Bắt buộc nếu chưa đăng nhập — id khách vãng lai do FE tự sinh (UUID), lưu cookie/localStorage',
})
@Controller('recently-viewed')
@UseGuards(OptionalJwtAuthGuard)
export class RecentlyViewedController {
  constructor(private readonly recentlyViewedService: RecentlyViewedService) {}

  @Post()
  @ApiOperation({ summary: 'Ghi nhận 1 lượt xem sản phẩm' })
  recordView(
    @CurrentUser() user: AuthenticatedUser | null,
    @Headers('x-guest-id') guestId: string | undefined,
    @Body() dto: RecordViewDto,
  ) {
    return this.recentlyViewedService.recordView(
      { userId: user?.id, guestId },
      dto.productId,
    );
  }

  @Get()
  @ApiOperation({ summary: 'Danh sách sản phẩm đã xem gần đây (tối đa 20)' })
  findMyRecentlyViewed(
    @CurrentUser() user: AuthenticatedUser | null,
    @Headers('x-guest-id') guestId: string | undefined,
  ) {
    return this.recentlyViewedService.findMyRecentlyViewed({
      userId: user?.id,
      guestId,
    });
  }
}
