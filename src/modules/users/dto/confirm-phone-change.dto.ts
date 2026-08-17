import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

export class ConfirmPhoneChangeDto {
  @ApiProperty()
  @IsString()
  newPhone: string;

  @ApiProperty({ description: 'Mã OTP 6 số' })
  @IsString()
  @Length(6, 6)
  code: string;
}
