import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InternalApiKeyGuard } from './internal-api-key.guard';

function createContext(headers: Record<string, string>): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers }),
    }),
  } as unknown as ExecutionContext;
}

function createConfig(value: string | undefined): ConfigService {
  return { get: () => value } as unknown as ConfigService;
}

describe('InternalApiKeyGuard', () => {
  it('header khớp đúng INTERNAL_NOTIFY_KEY → cho qua', () => {
    const guard = new InternalApiKeyGuard(createConfig('secret-key'));
    const context = createContext({ 'x-internal-key': 'secret-key' });

    expect(guard.canActivate(context)).toBe(true);
  });

  it('thiếu header → UnauthorizedException', () => {
    const guard = new InternalApiKeyGuard(createConfig('secret-key'));
    const context = createContext({});

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('header sai giá trị → UnauthorizedException', () => {
    const guard = new InternalApiKeyGuard(createConfig('secret-key'));
    const context = createContext({ 'x-internal-key': 'wrong' });

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('chưa cấu hình INTERNAL_NOTIFY_KEY (rỗng) → luôn từ chối dù header trống', () => {
    const guard = new InternalApiKeyGuard(createConfig(undefined));
    const context = createContext({ 'x-internal-key': '' });

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });
});
