import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface GhnResponse<T> {
  code: number;
  message: string;
  data: T;
}

// Client dùng chung cho mọi lần gọi API tính phí/leadtime của GHN — khác GhnClient bên
// backend-cms (chỉ dùng cho master-data sync, không cần header ShopId), client này luôn
// gửi kèm ShopId vì mọi endpoint shipping-order/* của GHN đều yêu cầu.
@Injectable()
export class GhnClient {
  private readonly logger = new Logger(GhnClient.name);
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly shopId: string;

  constructor(private readonly config: ConfigService) {
    this.baseUrl = this.config.get<string>(
      'GHN_API_BASE_URL',
      'https://dev-online-gateway.ghn.vn/shiip/public-api',
    );
    this.token = this.config.get<string>('GHN_API_TOKEN', '');
    this.shopId = this.config.get<string>('GHN_SHOP_ID', '');
  }

  post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    return this.request<T>(path, body);
  }

  private async request<T>(
    path: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    if (!this.token || !this.shopId) {
      throw new InternalServerErrorException(
        'Chưa cấu hình GHN_API_TOKEN/GHN_SHOP_ID — không thể gọi API GHN.',
      );
    }

    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        Token: this.token,
        ShopId: this.shopId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      this.logger.error(
        `GHN API lỗi ${response.status}: POST ${path} — ${errorBody}`,
      );
      throw new InternalServerErrorException('Không gọi được API GHN.');
    }

    const result = (await response.json()) as GhnResponse<T>;
    return result.data;
  }
}
