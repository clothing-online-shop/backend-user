import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { OtpModule } from '../../common/otp/otp.module';
import { MailModule } from '../mail/mail.module';

@Module({
  imports: [OtpModule, MailModule],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
