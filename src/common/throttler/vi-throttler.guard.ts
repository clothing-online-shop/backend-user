import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerException, ThrottlerGuard } from '@nestjs/throttler';
import type { ThrottlerLimitDetail } from '@nestjs/throttler';

@Injectable()
export class ViThrottlerGuard extends ThrottlerGuard {
  protected throwThrottlingException(
    _context: ExecutionContext,
    _throttlerLimitDetail: ThrottlerLimitDetail,
  ): Promise<void> {
    void _context;
    void _throttlerLimitDetail;
    return Promise.reject(
      new ThrottlerException(
        'Bạn thao tác quá nhanh, vui lòng thử lại sau ít phút.',
      ),
    );
  }
}
