import { ApiProperty } from '@nestjs/swagger';
import {
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  VN_PHONE_INVALID_MESSAGE,
  VN_PHONE_REGEX,
} from '../../../common/utils/phone.util';

export class CreateAddressDto {
  @ApiProperty()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  receiverName: string;

  @ApiProperty()
  @IsString()
  @Matches(VN_PHONE_REGEX, { message: VN_PHONE_INVALID_MESSAGE })
  phone: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  province: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  district: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  ward: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  detail: string;

  @ApiProperty({
    required: false,
    description:
      'Đặt làm mặc định — địa chỉ đầu tiên của tài khoản luôn tự động là mặc định dù không truyền field này.',
  })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}
