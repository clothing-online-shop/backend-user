import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString } from 'class-validator';

export class RequestEmailChangeDto {
  @ApiProperty()
  @IsEmail()
  newEmail: string;

  // Bắt buộc nhập lại mật khẩu — đổi email là đổi 1 trường dùng để khôi phục tài khoản, chỉ
  // dựa vào access token đang có là chưa đủ (token lộ là đổi được luôn email, dẫn tới chiếm
  // tài khoản qua "quên mật khẩu").
  @ApiProperty()
  @IsString()
  currentPassword: string;
}
