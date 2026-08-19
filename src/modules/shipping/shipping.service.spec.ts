import {
  BadRequestException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ShippingService } from './shipping.service';
import { PrismaService } from '../../config/prisma.service';
import { GhnClient } from '../../common/ghn/ghn-client.service';

function createMocks() {
  const addressFindUnique = jest.fn();
  const cartFindFirst = jest.fn();
  const prisma = {
    address: { findUnique: addressFindUnique },
    cart: { findFirst: cartFindFirst },
  } as unknown as PrismaService;

  const post = jest.fn();
  const ghnClient = { post } as unknown as GhnClient;

  const values: Record<string, string> = {
    GHN_FROM_DISTRICT_ID: '1442',
    GHN_FROM_WARD_CODE: '21211',
    GHN_SHOP_ID: '5000',
  };
  const config = {
    get: jest.fn((key: string, def?: string) => values[key] ?? def),
  } as unknown as ConfigService;

  return { prisma, addressFindUnique, cartFindFirst, ghnClient, post, config };
}

const baseAddress = {
  id: 'addr-1',
  userId: 'user-1',
  district: { ghnId: 1454 },
  ward: { ghnCode: '20308' },
};

function cartWithItems(weight: number | null) {
  return {
    items: [
      {
        quantity: 2,
        productVariant: {
          weight,
          product: { name: 'Áo thun basic' },
        },
      },
    ],
  };
}

describe('ShippingService.getFeeQuote', () => {
  it('trả về danh sách gói cước sắp theo phí tăng dần', async () => {
    const {
      prisma,
      addressFindUnique,
      cartFindFirst,
      ghnClient,
      post,
      config,
    } = createMocks();
    addressFindUnique.mockResolvedValue(baseAddress);
    cartFindFirst.mockResolvedValue(cartWithItems(300));
    post.mockImplementation((path: string) => {
      if (path === '/v2/shipping-order/available-services') {
        return Promise.resolve([
          { service_id: 1, service_type_id: 2, short_name: 'Nhanh' },
          { service_id: 2, service_type_id: 2, short_name: 'Tiết kiệm' },
        ]);
      }
      if (path === '/v2/shipping-order/fee') {
        return Promise.resolve({ total: 30000 });
      }
      if (path === '/v2/shipping-order/leadtime') {
        return Promise.resolve({ leadtime: 1750000000 });
      }
      throw new Error(`unexpected path ${path}`);
    });
    const service = new ShippingService(prisma, ghnClient, config);

    const result = await service.getFeeQuote('user-1', 'addr-1');

    expect(result).toHaveLength(2);
    expect(result[0].fee).toBe(30000);
    expect(result[0].expectedDeliveryTime).toBe(
      new Date(1750000000 * 1000).toISOString(),
    );
  });

  it('báo lỗi 400 khi giỏ hàng trống', async () => {
    const { prisma, addressFindUnique, cartFindFirst, ghnClient, config } =
      createMocks();
    addressFindUnique.mockResolvedValue(baseAddress);
    cartFindFirst.mockResolvedValue(null);
    const service = new ShippingService(prisma, ghnClient, config);

    await expect(service.getFeeQuote('user-1', 'addr-1')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('báo lỗi 400 kèm tên sản phẩm khi thiếu khối lượng', async () => {
    const { prisma, addressFindUnique, cartFindFirst, ghnClient, config } =
      createMocks();
    addressFindUnique.mockResolvedValue(baseAddress);
    cartFindFirst.mockResolvedValue(cartWithItems(null));
    const service = new ShippingService(prisma, ghnClient, config);

    await expect(service.getFeeQuote('user-1', 'addr-1')).rejects.toThrow(
      'Áo thun basic',
    );
  });

  it('báo lỗi 404 khi địa chỉ không thuộc user', async () => {
    const { prisma, addressFindUnique, ghnClient, config } = createMocks();
    addressFindUnique.mockResolvedValue({
      ...baseAddress,
      userId: 'other-user',
    });
    const service = new ShippingService(prisma, ghnClient, config);

    await expect(service.getFeeQuote('user-1', 'addr-1')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('báo lỗi 500 khi GHN API lỗi', async () => {
    const {
      prisma,
      addressFindUnique,
      cartFindFirst,
      ghnClient,
      post,
      config,
    } = createMocks();
    addressFindUnique.mockResolvedValue(baseAddress);
    cartFindFirst.mockResolvedValue(cartWithItems(300));
    post.mockRejectedValue(
      new InternalServerErrorException('Không gọi được API GHN.'),
    );
    const service = new ShippingService(prisma, ghnClient, config);

    await expect(service.getFeeQuote('user-1', 'addr-1')).rejects.toThrow(
      InternalServerErrorException,
    );
  });
});
