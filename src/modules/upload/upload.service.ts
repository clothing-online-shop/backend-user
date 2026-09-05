import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary, UploadApiResponse } from 'cloudinary';

export interface UploadResult {
  url: string;
  publicId: string;
}

// Cùng gốc "clothing-shop" như backend-cms (chung 1 tài khoản Cloudinary) nhưng tách riêng
// nhánh con "users/<userId>" — khác backend-cms (admin, mọi role được xoá mọi ảnh trong cả
// folder), ở đây publicId đưa lên do chính khách hàng tự truyền nên phải giới hạn đúng
// nhánh của riêng họ, không thì user A có thể đoán/xoá được avatar user B hoặc ảnh sản
// phẩm/banner do CMS upload.
const UPLOAD_ROOT = 'clothing-shop/users';
const MAX_DIMENSION_PX = 2000;

@Injectable()
export class UploadService {
  private readonly logger = new Logger(UploadService.name);
  private readonly configured: boolean;

  constructor(private readonly config: ConfigService) {
    const cloudName = this.config.get<string>('CLOUDINARY_CLOUD_NAME');
    const apiKey = this.config.get<string>('CLOUDINARY_API_KEY');
    const apiSecret = this.config.get<string>('CLOUDINARY_API_SECRET');

    this.configured = Boolean(cloudName && apiKey && apiSecret);
    if (this.configured) {
      cloudinary.config({
        cloud_name: cloudName,
        api_key: apiKey,
        api_secret: apiSecret,
      });
    } else {
      this.logger.warn(
        'Thiếu CLOUDINARY_CLOUD_NAME/CLOUDINARY_API_KEY/CLOUDINARY_API_SECRET trong .env — upload ảnh sẽ báo lỗi cho đến khi cấu hình.',
      );
    }
  }

  async uploadImage(
    file: Express.Multer.File,
    userId: string,
  ): Promise<UploadResult> {
    this.assertConfigured();

    const result = await new Promise<UploadApiResponse>((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: this.userFolder(userId),
          resource_type: 'image',
          // Tự resize (không phóng to nếu ảnh nhỏ hơn) + tự nén: giảm dung lượng ảnh
          // avatar mà không cần xử lý thủ công trước khi upload — cùng convention với
          // backend-cms.
          transformation: [
            {
              width: MAX_DIMENSION_PX,
              height: MAX_DIMENSION_PX,
              crop: 'limit',
            },
            { quality: 'auto', fetch_format: 'auto' },
          ],
        },
        (error, uploadResult) => {
          if (error || !uploadResult) {
            reject(
              error instanceof Error
                ? error
                : new Error(error?.message ?? 'Upload ảnh thất bại'),
            );
            return;
          }
          resolve(uploadResult);
        },
      );
      stream.end(file.buffer);
    });

    return { url: result.secure_url, publicId: result.public_id };
  }

  async deleteImage(publicId: string, userId: string): Promise<void> {
    this.assertConfigured();
    if (!publicId.startsWith(`${this.userFolder(userId)}/`)) {
      throw new BadRequestException('publicId không hợp lệ');
    }
    await cloudinary.uploader.destroy(publicId);
  }

  private userFolder(userId: string): string {
    return `${UPLOAD_ROOT}/${userId}`;
  }

  private assertConfigured(): void {
    if (!this.configured) {
      throw new ServiceUnavailableException(
        'Cloudinary chưa được cấu hình. Vui lòng thêm CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET vào .env',
      );
    }
  }
}
