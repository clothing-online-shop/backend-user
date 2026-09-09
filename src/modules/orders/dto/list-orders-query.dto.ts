import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Min } from 'class-validator';

export class ListOrdersQueryDto {
  @ApiPropertyOptional({
    description:
      'Danh sách OrderStatus muốn lọc, phân tách bởi dấu phẩy (vd "CONFIRMED,PACKING,HANDED_OVER,SHIPPING"). Bỏ trống = lấy tất cả trạng thái.',
  })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 10 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}
