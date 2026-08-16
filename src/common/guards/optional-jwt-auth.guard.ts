import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { AuthenticatedUser } from '../../modules/auth/strategies/jwt.strategy';

// Dùng cho route hoạt động được cả khi có/không có Bearer token (ví dụ: đã xem gần đây
// theo tài khoản HOẶC khách vãng lai) — khác JwtAuthGuard thường, không throw khi thiếu/
// sai token, trả `null` để route tự xử lý tiếp bằng định danh khác (guestId).
@Injectable()
export class OptionalJwtAuthGuard extends AuthGuard('jwt') {
  handleRequest<TUser = AuthenticatedUser>(
    _err: unknown,
    user: TUser | false,
  ): TUser | null {
    return user || null;
  }
}
