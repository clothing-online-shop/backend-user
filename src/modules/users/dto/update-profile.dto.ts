import { ApiPropertyOptional } from '@nestjs/swagger';
import { Gender } from '@prisma/client';
import {
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';

export class UpdateProfileDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(2)
  fullName?: string;

  @ApiPropertyOptional({ description: 'ISO date, ví dụ 2000-01-01' })
  @IsOptional()
  @IsDateString()
  dateOfBirth?: string;

  @ApiPropertyOptional({ enum: Gender })
  @IsOptional()
  @IsEnum(Gender)
  gender?: Gender;

  // string | null (không chỉ string) để phân biệt "không đổi" (bỏ trống field) với "gỡ
  // avatar" (gửi null) — cùng convention avatarUrl/avatarPublicId song song như ảnh sản
  // phẩm bên backend-cms (products.service.ts).
  @ApiPropertyOptional({ nullable: true, description: 'null để gỡ avatar' })
  @IsOptional()
  @IsString()
  avatarUrl?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  avatarPublicId?: string | null;
}
