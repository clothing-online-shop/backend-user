import { ThrottlerException } from '@nestjs/throttler';
import { ViThrottlerGuard } from './vi-throttler.guard';

describe('ViThrottlerGuard', () => {
  it('throws a Vietnamese ThrottlerException', async () => {
    const guard = Object.create(ViThrottlerGuard.prototype) as ViThrottlerGuard;
    await expect(
      (
        guard as unknown as { throwThrottlingException: () => Promise<void> }
      ).throwThrottlingException(),
    ).rejects.toBeInstanceOf(ThrottlerException);
    await (
      guard as unknown as { throwThrottlingException: () => Promise<void> }
    )
      .throwThrottlingException()
      .catch((e: Error) => expect(e.message).toMatch(/quá nhanh|thử lại sau/i));
  });
});
