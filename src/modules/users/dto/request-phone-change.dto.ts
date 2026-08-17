import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export class RequestPhoneChangeDto {
  @ApiProperty()
  @IsString()
  newPhone: string;
}
