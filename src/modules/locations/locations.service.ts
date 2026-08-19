import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../config/prisma.service';

@Injectable()
export class LocationsService {
  constructor(private readonly prisma: PrismaService) {}

  findProvinces() {
    return this.prisma.province.findMany({ orderBy: { name: 'asc' } });
  }

  async findDistricts(provinceId: string) {
    const province = await this.prisma.province.findUnique({
      where: { id: provinceId },
    });
    if (!province) {
      throw new NotFoundException('Không tìm thấy tỉnh/thành phố.');
    }
    return this.prisma.district.findMany({
      where: { provinceId },
      orderBy: { name: 'asc' },
    });
  }

  async findWards(districtId: string) {
    const district = await this.prisma.district.findUnique({
      where: { id: districtId },
    });
    if (!district) {
      throw new NotFoundException('Không tìm thấy quận/huyện.');
    }
    return this.prisma.ward.findMany({
      where: { districtId },
      orderBy: { name: 'asc' },
    });
  }
}
