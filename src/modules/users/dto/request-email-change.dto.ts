import { ApiProperty } from '@nestjs/swagger';
import { IsEmail } from 'class-validator';

export class RequestEmailChangeDto {
  @ApiProperty()
  @IsEmail()
  newEmail: string;
}
