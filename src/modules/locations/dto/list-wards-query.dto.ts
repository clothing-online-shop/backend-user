import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class ListWardsQueryDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  districtId!: string;
}
