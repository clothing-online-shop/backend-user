import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { timingSafeEqualString } from '../utils/timing-safe-compare.util';

// Xác thực server-to-server (backend-cms gọi sang) — không có JWT khách hàng nên không dùng
// JwtAuthGuard. So khớp header x-internal-key với secret dùng chung INTERNAL_NOTIFY_KEY.
@Injectable()
export class InternalApiKeyGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const expectedKey = this.config.get<string>('INTERNAL_NOTIFY_KEY');
    const providedKey = request.headers['x-internal-key'];

    if (
      !expectedKey ||
      typeof providedKey !== 'string' ||
      !timingSafeEqualString(providedKey, expectedKey)
    ) {
      throw new UnauthorizedException('Không có quyền truy cập.');
    }
    return true;
  }
}
