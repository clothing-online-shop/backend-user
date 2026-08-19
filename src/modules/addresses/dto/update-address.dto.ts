import { ApiProperty } from '@nestjs/swagger';
import {
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

// Không có field isDefault ở đây — đặt mặc định là 1 hành động riêng (PATCH :id/default),
// tránh 1 endpoint làm 2 việc (sửa thông tin + đổi mặc định) và tránh vô tình bỏ mặc định
// khi client chỉ định gửi thiếu field.
export class UpdateAddressDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  receiverName?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @Matches(VN_PHONE_REGEX, { message: VN_PHONE_INVALID_MESSAGE })
  phone?: string;

  @ApiProperty({ required: false, description: 'id tỉnh/thành phố' })
  @IsOptional()
  @IsString()
  provinceId?: string;

  @ApiProperty({ required: false, description: 'id quận/huyện' })
  @IsOptional()
  @IsString()
  districtId?: string;

  @ApiProperty({ required: false, description: 'id phường/xã' })
  @IsOptional()
  @IsString()
  wardId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  detail?: string;
}
