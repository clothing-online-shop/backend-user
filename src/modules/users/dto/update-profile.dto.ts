import { ApiPropertyOptional } from '@nestjs/swagger';
import { Gender } from '@prisma/client';
import {
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  MinLength,
  registerDecorator,
  ValidationOptions,
} from 'class-validator';

function IsNotFutureDate(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    const ctor = (
      object as { constructor: new (...args: unknown[]) => unknown }
    ).constructor;
    registerDecorator({
      name: 'isNotFutureDate',
      target: ctor,
      propertyName,
      options: {
        message: 'Ngày sinh không được là ngày trong tương lai',
        ...validationOptions,
      },
      validator: {
        validate(value: unknown) {
          if (typeof value !== 'string') return false;
          const inputDate = new Date(value);
          if (isNaN(inputDate.getTime())) return false;
          // So sánh chỉ theo ngày (bỏ qua giờ), tránh lỗi timezone
          const today = new Date();
          today.setHours(23, 59, 59, 999);
          return inputDate <= today;
        },
      },
    });
  };
}

export class UpdateProfileDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(2)
  fullName?: string;

  @ApiPropertyOptional({
    description:
      'ISO date, ví dụ 2000-01-01. Không được là ngày trong tương lai.',
  })
  @IsOptional()
  @IsDateString()
  @IsNotFutureDate()
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
