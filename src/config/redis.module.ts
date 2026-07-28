import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

export const REDIS_CLIENT = 'REDIS_CLIENT';

// TODO: wire up caching/session helpers on top of this client in a later sprint
@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        return new Redis(
          config.get<string>('REDIS_URL', 'redis://localhost:6379'),
        );
      },
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule {}
