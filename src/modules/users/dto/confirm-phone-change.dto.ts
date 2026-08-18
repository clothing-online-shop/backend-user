import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length, Matches } from 'class-validator';
import {
  VN_PHONE_INVALID_MESSAGE,
  VN_PHONE_REGEX,
} from '../../../common/utils/phone.util';

export class ConfirmPhoneChangeDto {
  @ApiProperty()
  @IsString()
  @Matches(VN_PHONE_REGEX, { message: VN_PHONE_INVALID_MESSAGE })
  newPhone: string;

  @ApiProperty({ description: 'Mã OTP 6 số' })
  @IsString()
  @Length(6, 6)
  code: string;
}
