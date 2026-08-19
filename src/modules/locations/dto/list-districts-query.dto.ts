import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class ListDistrictsQueryDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  provinceId!: string;
}
