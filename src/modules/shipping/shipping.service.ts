import {
  BadRequestException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../config/prisma.service';
import { GhnClient } from '../../common/ghn/ghn-client.service';

interface GhnAvailableService {
  service_id: number;
  service_type_id: number;
  short_name: string;
}

interface GhnFeeResponse {
  total: number;
}

interface GhnLeadtimeResponse {
  leadtime: number; // unix timestamp (giây)
}

export interface ShippingFeeOption {
  serviceId: number;
  serviceTypeId: number;
  name: string;
  fee: number;
  expectedDeliveryTime: string; // ISO 8601
}

@Injectable()
export class ShippingService {
  private readonly logger = new Logger(ShippingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ghnClient: GhnClient,
    private readonly config: ConfigService,
  ) {}

  async getFeeQuote(
    userId: string,
    addressId: string,
  ): Promise<ShippingFeeOption[]> {
    const address = await this.prisma.address.findUnique({
      where: { id: addressId },
      include: { district: true, ward: true },
    });
    if (!address || address.userId !== userId) {
      throw new NotFoundException('Không tìm thấy địa chỉ.');
    }

    const cart = await this.prisma.cart.findFirst({
      where: { userId },
      include: {
        items: {
          include: { productVariant: { include: { product: true } } },
        },
      },
    });
    if (!cart || cart.items.length === 0) {
      throw new BadRequestException('Giỏ hàng trống, không thể tính phí ship.');
    }

    const missingWeight = cart.items.filter(
      (item) => item.productVariant.weight == null,
    );
    if (missingWeight.length > 0) {
      const names = missingWeight
        .map((item) => item.productVariant.product.name)
        .join(', ');
      throw new BadRequestException(
        `Sản phẩm chưa có thông tin khối lượng, không thể tính phí ship: ${names}.`,
      );
    }

    const totalWeight = cart.items.reduce(
      (sum, item) => sum + item.productVariant.weight! * item.quantity,
      0,
    );

    const fromDistrictId = Number(
      this.config.get<string>('GHN_FROM_DISTRICT_ID', '0'),
    );
    const fromWardCode = this.config.get<string>('GHN_FROM_WARD_CODE', '');
    const toDistrictId = address.district.ghnId;
    const toWardCode = address.ward.ghnCode;

    try {
      const services = await this.ghnClient.post<GhnAvailableService[]>(
        '/v2/shipping-order/available-services',
        {
          shop_id: Number(this.config.get<string>('GHN_SHOP_ID', '0')),
          from_district: fromDistrictId,
          to_district: toDistrictId,
        },
      );

      if (!Array.isArray(services)) {
        this.logger.error(
          `GHN available-services trả về dữ liệu không hợp lệ (không phải mảng): ${JSON.stringify(
            services,
          )}`,
        );
        throw new InternalServerErrorException(
          'Không tính được phí ship, vui lòng thử lại.',
        );
      }

      const options = await Promise.all(
        services.map(async (service) => {
          const [feeResult, leadtimeResult] = await Promise.all([
            this.ghnClient.post<GhnFeeResponse>('/v2/shipping-order/fee', {
              service_id: service.service_id,
              service_type_id: service.service_type_id,
              from_district_id: fromDistrictId,
              from_ward_code: fromWardCode,
              to_district_id: toDistrictId,
              to_ward_code: toWardCode,
              weight: totalWeight,
            }),
            this.ghnClient.post<GhnLeadtimeResponse>(
              '/v2/shipping-order/leadtime',
              {
                from_district_id: fromDistrictId,
                from_ward_code: fromWardCode,
                to_district_id: toDistrictId,
                to_ward_code: toWardCode,
                service_id: service.service_id,
              },
            ),
          ]);

          return {
            serviceId: service.service_id,
            serviceTypeId: service.service_type_id,
            name: service.short_name,
            fee: feeResult.total,
            expectedDeliveryTime: new Date(
              leadtimeResult.leadtime * 1000,
            ).toISOString(),
          };
        }),
      );

      return options.sort((a, b) => a.fee - b.fee);
    } catch (err) {
      if (err instanceof HttpException) {
        throw err;
      }
      this.logger.error(
        `Lỗi không xác định khi tính phí ship qua GHN: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      throw new InternalServerErrorException(
        'Không tính được phí ship, vui lòng thử lại.',
      );
    }
  }
}
