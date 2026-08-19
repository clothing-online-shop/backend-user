import { Module } from '@nestjs/common';
import { GhnClient } from './ghn-client.service';

@Module({
  providers: [GhnClient],
  exports: [GhnClient],
})
export class GhnModule {}
