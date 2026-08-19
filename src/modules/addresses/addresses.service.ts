import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Address, Prisma } from '@prisma/client';
import { PrismaService } from '../../config/prisma.service';
import { CreateAddressDto } from './dto/create-address.dto';
import { UpdateAddressDto } from './dto/update-address.dto';

// Address chỉ lưu provinceId/districtId/wardId (cuid) — include thêm tên tỉnh/huyện/xã để
// mọi response trả về client đều có tên đọc được, không phải id trần.
const addressLocationInclude = {
  province: { select: { id: true, name: true } },
  district: { select: { id: true, name: true } },
  ward: { select: { id: true, name: true } },
} as const;

type AddressWithLocation = Prisma.AddressGetPayload<{
  include: typeof addressLocationInclude;
}>;

@Injectable()
export class AddressesService {
  // Giới hạn số địa chỉ lưu/tài khoản — tránh sổ địa chỉ phình vô hạn (Shopee/Lazada cũng
  // giới hạn tương tự, quanh 20).
  private readonly MAX_ADDRESSES_PER_USER = 10;

  // 2 request đồng thời cùng đổi cờ mặc định/đếm số địa chỉ của cùng 1 user là trường hợp
  // hiếm (double-click, 2 tab) — dùng transaction Serializable để Postgres tự phát hiện
  // xung đột (lỗi P2034) thay vì để race làm sai bất biến "luôn đúng 1 địa chỉ mặc định"
  // hay lách qua giới hạn số lượng. Thử lại vài lần khi gặp xung đột, không cần backoff.
  private readonly MAX_SERIALIZATION_RETRIES = 3;

  constructor(private readonly prisma: PrismaService) {}

  findMyAddresses(userId: string): Promise<AddressWithLocation[]> {
    return this.prisma.address.findMany({
      where: { userId },
      orderBy: [{ isDefault: 'desc' }, { id: 'desc' }],
      include: addressLocationInclude,
    });
  }

  async createAddress(
    userId: string,
    dto: CreateAddressDto,
  ): Promise<AddressWithLocation> {
    // provinces/districts/wards là dữ liệu tham chiếu tĩnh, không tham gia bất biến mà
    // transaction Serializable bên dưới bảo vệ (đếm số địa chỉ/cờ mặc định) — validate
    // trước, ngoài transaction, để không giữ 2 connection cùng lúc (1 cho transaction
    // interactive, 1 cho query validate) và tránh nguy cơ cạn pool/tự deadlock khi tải cao.
    await this.validateLocationChain(
      dto.provinceId,
      dto.districtId,
      dto.wardId,
    );

    return this.runSerializable(async (tx) => {
      const count = await tx.address.count({ where: { userId } });
      if (count >= this.MAX_ADDRESSES_PER_USER) {
        throw new BadRequestException(
          `Chỉ được lưu tối đa ${this.MAX_ADDRESSES_PER_USER} địa chỉ.`,
        );
      }

      // Địa chỉ đầu tiên của tài khoản luôn là mặc định — không để trường hợp đã có địa
      // chỉ nhưng không có địa chỉ mặc định nào (checkout sau này cần luôn có 1 default để
      // chọn sẵn).
      const isFirstAddress = count === 0;
      const isDefault = isFirstAddress || dto.isDefault === true;

      if (isDefault && !isFirstAddress) {
        await tx.address.updateMany({
          where: { userId, isDefault: true },
          data: { isDefault: false },
        });
      }

      return tx.address.create({
        data: {
          userId,
          receiverName: dto.receiverName,
          phone: dto.phone,
          provinceId: dto.provinceId,
          districtId: dto.districtId,
          wardId: dto.wardId,
          detail: dto.detail,
          isDefault,
        },
        include: addressLocationInclude,
      });
    });
  }

  async updateAddress(
    userId: string,
    addressId: string,
    dto: UpdateAddressDto,
  ): Promise<AddressWithLocation> {
    const existing = await this.findOwned(this.prisma, userId, addressId);

    const provinceId = dto.provinceId ?? existing.provinceId;
    const districtId = dto.districtId ?? existing.districtId;
    const wardId = dto.wardId ?? existing.wardId;
    if (
      dto.provinceId !== undefined ||
      dto.districtId !== undefined ||
      dto.wardId !== undefined
    ) {
      await this.validateLocationChain(provinceId, districtId, wardId);
    }

    return this.prisma.address.update({
      where: { id: addressId },
      data: {
        receiverName: dto.receiverName,
        phone: dto.phone,
        provinceId,
        districtId,
        wardId,
        detail: dto.detail,
      },
      include: addressLocationInclude,
    });
  }

  setDefault(userId: string, addressId: string): Promise<AddressWithLocation> {
    return this.runSerializable(async (tx) => {
      const address = await this.findOwned(tx, userId, addressId);
      if (address.isDefault) {
        // findOwned không include tên tỉnh/huyện/xã (chỉ dùng nội bộ để check quyền sở
        // hữu) — fetch lại kèm include để trả đủ dữ liệu cho client, không đụng tới
        // findOwned để tránh phải include ở mọi nơi khác đang gọi nó.
        return tx.address.findUniqueOrThrow({
          where: { id: addressId },
          include: addressLocationInclude,
        });
      }

      await tx.address.updateMany({
        where: { userId, isDefault: true },
        data: { isDefault: false },
      });
      return tx.address.update({
        where: { id: addressId },
        data: { isDefault: true },
        include: addressLocationInclude,
      });
    });
  }

  deleteAddress(userId: string, addressId: string): Promise<void> {
    return this.runSerializable(async (tx) => {
      const address = await this.findOwned(tx, userId, addressId);
      await tx.address.delete({ where: { id: addressId } });

      if (!address.isDefault) {
        return;
      }

      // Vừa xóa xong địa chỉ mặc định — nếu còn địa chỉ khác, tự gán 1 cái làm mặc định
      // mới thay vì để sổ địa chỉ "còn hàng nhưng không có mặc định". Sắp theo id giảm dần
      // (cuid có tính tăng dần theo thời gian tạo, nhưng chỉ là xấp xỉ — không phải cột
      // createdAt thật, vì model Address thuộc schema dùng chung, không thể tự thêm cột từ
      // repo này) để ưu tiên địa chỉ mới thêm gần nhất.
      const fallback = await tx.address.findFirst({
        where: { userId },
        orderBy: { id: 'desc' },
      });
      if (fallback) {
        await tx.address.update({
          where: { id: fallback.id },
          data: { isDefault: true },
        });
      }
    });
  }

  // Xác nhận districtId thuộc đúng provinceId và wardId thuộc đúng districtId. Không cần
  // check riêng provinceId tồn tại — nếu district tồn tại và district.provinceId khớp thì
  // provinceId chắc chắn hợp lệ (FK ràng buộc District.province luôn trỏ tới 1 Province có
  // thật), tránh 1 query thừa.
  private async validateLocationChain(
    provinceId: string,
    districtId: string,
    wardId: string,
  ): Promise<void> {
    const district = await this.prisma.district.findUnique({
      where: { id: districtId },
    });
    if (!district || district.provinceId !== provinceId) {
      throw new BadRequestException(
        'Quận/huyện không hợp lệ hoặc không thuộc tỉnh/thành phố đã chọn.',
      );
    }

    const ward = await this.prisma.ward.findUnique({ where: { id: wardId } });
    if (!ward || ward.districtId !== districtId) {
      throw new BadRequestException(
        'Phường/xã không hợp lệ hoặc không thuộc quận/huyện đã chọn.',
      );
    }
  }

  // Kết hợp "tìm" và "có phải của mình không" thành 1 lỗi 404 duy nhất — không xác nhận sự
  // tồn tại của địa chỉ thuộc về user khác (cùng cách CartService.findOwnedItem làm). Nhận
  // `client` thay vì luôn dùng `this.prisma` để dùng được cả bên trong transaction.
  private async findOwned(
    client: Prisma.TransactionClient | PrismaService,
    userId: string,
    addressId: string,
  ): Promise<Address> {
    const address = await client.address.findUnique({
      where: { id: addressId },
    });
    if (!address || address.userId !== userId) {
      throw new NotFoundException('Không tìm thấy địa chỉ.');
    }
    return address;
  }

  private async runSerializable<T>(
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    for (
      let attempt = 1;
      attempt <= this.MAX_SERIALIZATION_RETRIES;
      attempt++
    ) {
      try {
        return await this.prisma.$transaction(fn, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (err) {
        const isSerializationConflict =
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2034';
        if (
          !isSerializationConflict ||
          attempt === this.MAX_SERIALIZATION_RETRIES
        ) {
          throw err;
        }
      }
    }
    // Không bao giờ tới đây — vòng lặp trên luôn return hoặc throw ở lần thử cuối.
    throw new Error('unreachable');
  }
}
