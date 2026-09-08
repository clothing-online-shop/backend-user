import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class RecordSearchDto {
  @ApiProperty({ description: 'Từ khoá người dùng vừa tìm kiếm' })
  @IsString()
  @MinLength(1)
  keyword!: string;
}
