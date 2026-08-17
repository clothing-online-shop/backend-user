import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';
import {
  VN_PHONE_INVALID_MESSAGE,
  VN_PHONE_REGEX,
} from '../../../common/utils/phone.util';

export class RequestPhoneChangeDto {
  @ApiProperty()
  @IsString()
  @Matches(VN_PHONE_REGEX, { message: VN_PHONE_INVALID_MESSAGE })
  newPhone: string;

  // Bắt buộc nhập lại mật khẩu — cùng lý do với RequestEmailChangeDto.currentPassword.
  @ApiProperty()
  @IsString()
  currentPassword: string;
}
