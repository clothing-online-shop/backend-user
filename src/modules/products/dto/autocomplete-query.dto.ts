import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class AutocompleteQueryDto {
  @ApiPropertyOptional({
    description: 'Từ khoá gõ tìm kiếm, chỉ trả gợi ý khi >= 2 ký tự',
  })
  @IsOptional()
  @IsString()
  q?: string;
}
