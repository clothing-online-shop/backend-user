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
import { SearchHistoryService } from './search-history.service';
import { RecordSearchDto } from './dto/record-search.dto';

@ApiTags('search-history')
@ApiHeader({
  name: 'X-Guest-Id',
  required: false,
  description:
    'Bắt buộc nếu chưa đăng nhập — id khách vãng lai do FE tự sinh (UUID), lưu cookie/localStorage',
})
@Controller('search-history')
@UseGuards(OptionalJwtAuthGuard)
export class SearchHistoryController {
  constructor(private readonly searchHistoryService: SearchHistoryService) {}

  @Post()
  @ApiOperation({ summary: 'Ghi nhận 1 từ khoá vừa tìm kiếm' })
  recordSearch(
    @CurrentUser() user: AuthenticatedUser | null,
    @Headers('x-guest-id') guestId: string | undefined,
    @Body() dto: RecordSearchDto,
  ) {
    return this.searchHistoryService.recordSearch(
      { userId: user?.id, guestId },
      dto.keyword,
    );
  }

  @Get()
  @ApiOperation({ summary: 'Danh sách từ khoá tìm kiếm gần đây (tối đa 5)' })
  findMyRecentSearches(
    @CurrentUser() user: AuthenticatedUser | null,
    @Headers('x-guest-id') guestId: string | undefined,
  ) {
    return this.searchHistoryService.findMyRecentSearches({
      userId: user?.id,
      guestId,
    });
  }
}
