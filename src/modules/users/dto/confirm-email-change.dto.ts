import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, Length } from 'class-validator';

export class ConfirmEmailChangeDto {
  @ApiProperty()
  @IsEmail()
  newEmail: string;

  @ApiProperty({ description: 'Mã OTP 6 số' })
  @IsString()
  @Length(6, 6)
  code: string;
}
