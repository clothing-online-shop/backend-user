# GHN Shipping Fee Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Checkout-time endpoint that maps a saved address to GHN location codes, sums the current cart's weight, and returns available GHN shipping packages with fee and estimated delivery time.

**Architecture:** Six sequential tasks: bump the shared schema submodule, expose read-only location lookups for the address form, switch the `addresses` module to FK ids, add a GHN HTTP client, add the `shipping` module that orchestrates GHN's available-services/fee/leadtime calls, then unit-test it. No changes to `orders` (still a stub, out of scope) or to `Order` (fee is quoted, not persisted).

**Tech Stack:** NestJS 11, Prisma 6 (schema via `vendor/backend-cms` submodule), class-validator, Jest, native `fetch`.

**Spec:** [`docs/superpowers/specs/2026-08-19-ghn-shipping-fee-design.md`](../specs/2026-08-19-ghn-shipping-fee-design.md)

**Prerequisite:** `backend-cms`'s `2026-08-19-ghn-shipping-schema.md` plan (Tasks 1-2) must be committed first — this repo's `Task 1` bumps the submodule to that commit. Do not start Task 3 onward before the submodule bump lands (they depend on `ProductVariant.weight` and `Address.provinceId/districtId/wardId` existing in the generated Prisma Client).

## Global Constraints

- 1 module = 1 domain under `src/modules/<name>/`, controller only calls service (CLAUDE.md).
- Every DTO field needs `@ApiProperty()`/`@ApiPropertyOptional()` (CLAUDE.md).
- `ValidationPipe` has `whitelist`/`forbidNonWhitelisted` on — extra body fields are rejected by design (CLAUDE.md).
- Throw Nest's built-in `HttpException` subclasses (`BadRequestException`, `NotFoundException`, `InternalServerErrorException`...); don't hand-roll error responses — `AllExceptionsFilter` formats them globally (CLAUDE.md).
- Never leak internal error detail (stack trace, raw 3rd-party error body) to the client (CLAUDE.md).
- Routes needing login: `@UseGuards(JwtAuthGuard)`, current user via `@CurrentUser() user: AuthenticatedUser` (CLAUDE.md).
- Inject `PrismaService`, never instantiate `PrismaClient` directly (CLAUDE.md).
- New env vars go in `.env.example` with dev-safe placeholders, never real secrets (CLAUDE.md).
- Before opening a PR: `pnpm --filter @clothing-shop/be lint` (0 errors), `pnpm --filter @clothing-shop/be build` (passes), `pnpm --filter @clothing-shop/be test` (passes).
- Branch: `feature/ghn-shipping-fee` (already created from `fix-develop`, spec doc already committed as `c90c9de`).

---

### Task 1: Bump `vendor/backend-cms` submodule

**Files:**
- Modify: `vendor/backend-cms` (submodule pointer)

**Interfaces:**
- Produces: regenerated `@prisma/client` types with `ProductVariant.weight` and `Address.provinceId/districtId/wardId` — every later task in this plan depends on these types existing.

- [ ] **Step 1: Point the submodule at the schema branch**

Run:
```bash
cd vendor/backend-cms
git fetch origin
git checkout feature/ghn-shipping-schema
cd ../..
```

Expected: `git -C vendor/backend-cms log -1 --oneline` shows the `feat(addresses): switch Address to FK references...` commit from the `backend-cms` plan.

- [ ] **Step 2: Regenerate the Prisma Client**

Run: `pnpm prisma:generate`
Expected: succeeds, no errors. If it fails with `EPERM`, stop the dev server first (Windows file lock on `query_engine-windows.dll.node`) and retry.

- [ ] **Step 3: Verify the new fields are visible to TypeScript**

Run: `pnpm --filter @clothing-shop/be build`
Expected: PASS. (Existing code doesn't reference `Address.province/district/ward` outside the `addresses` module, which Task 3 fixes next — if build fails elsewhere, note the error before continuing.)

- [ ] **Step 4: Commit the submodule bump**

```bash
git add vendor/backend-cms
git commit -m "chore: bump backend-cms submodule for GHN shipping schema"
```

---

### Task 2: Read-only `locations` module

**Files:**
- Create: `src/modules/locations/locations.module.ts`
- Create: `src/modules/locations/locations.service.ts`
- Create: `src/modules/locations/locations.controller.ts`
- Create: `src/modules/locations/dto/list-districts-query.dto.ts`
- Create: `src/modules/locations/dto/list-wards-query.dto.ts`
- Modify: `src/app.module.ts`

**Interfaces:**
- Produces: `GET /locations/provinces`, `GET /locations/districts?provinceId=`, `GET /locations/wards?districtId=` — public (no guard), returns `Province[]`/`District[]`/`Ward[]` as stored in Prisma (`{ id, ghnId, name }` / `{ id, ghnId, provinceId, name }` / `{ id, ghnCode, districtId, name }`). Consumed by Task 3's address validation indirectly (same tables) and by the (out-of-scope) FE address form.

- [ ] **Step 1: Query DTOs**

Create `src/modules/locations/dto/list-districts-query.dto.ts`:

```ts
import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class ListDistrictsQueryDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  provinceId!: string;
}
```

Create `src/modules/locations/dto/list-wards-query.dto.ts`:

```ts
import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class ListWardsQueryDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  districtId!: string;
}
```

- [ ] **Step 2: Service**

Create `src/modules/locations/locations.service.ts`:

```ts
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
```

- [ ] **Step 3: Controller — public, no `/sync` route**

Create `src/modules/locations/locations.controller.ts`:

```ts
import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { LocationsService } from './locations.service';
import { ListDistrictsQueryDto } from './dto/list-districts-query.dto';
import { ListWardsQueryDto } from './dto/list-wards-query.dto';

@ApiTags('locations')
@Controller('locations')
export class LocationsController {
  constructor(private readonly locationsService: LocationsService) {}

  @Get('provinces')
  @ApiOperation({ summary: 'Danh sách tỉnh/thành phố' })
  findProvinces() {
    return this.locationsService.findProvinces();
  }

  @Get('districts')
  @ApiOperation({ summary: 'Danh sách quận/huyện theo tỉnh/thành phố' })
  findDistricts(@Query() query: ListDistrictsQueryDto) {
    return this.locationsService.findDistricts(query.provinceId);
  }

  @Get('wards')
  @ApiOperation({ summary: 'Danh sách phường/xã theo quận/huyện' })
  findWards(@Query() query: ListWardsQueryDto) {
    return this.locationsService.findWards(query.districtId);
  }
}
```

- [ ] **Step 4: Module**

Create `src/modules/locations/locations.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { LocationsController } from './locations.controller';
import { LocationsService } from './locations.service';

@Module({
  controllers: [LocationsController],
  providers: [LocationsService],
})
export class LocationsModule {}
```

- [ ] **Step 5: Register in `AppModule`**

Edit `src/app.module.ts` — add the import and list it alongside the other feature modules:

```ts
import { LocationsModule } from './modules/locations/locations.module';
```

```ts
    AddressesModule,
    LocationsModule,
```

- [ ] **Step 6: Manual smoke test**

Run: `pnpm start:dev`, then `curl http://localhost:3001/locations/provinces` (or open Swagger at `/api/docs`).
Expected: 200 with the province list synced earlier by `backend-cms`'s `LocationsService.syncFromGhn()`. `curl http://localhost:3001/locations/districts?provinceId=<bad-id>` should return 404.

- [ ] **Step 7: Commit**

```bash
git add src/modules/locations src/app.module.ts
git commit -m "feat(locations): add public read-only province/district/ward lookup"
```

---

### Task 3: `addresses` module — switch to location ids

**Files:**
- Modify: `src/modules/addresses/dto/create-address.dto.ts`
- Modify: `src/modules/addresses/dto/update-address.dto.ts`
- Modify: `src/modules/addresses/addresses.service.ts`

**Interfaces:**
- Consumes: `PrismaService.district.findUnique`, `PrismaService.ward.findUnique` (from Task 1's regenerated client).
- Produces: `CreateAddressDto`/`UpdateAddressDto` with `provinceId/districtId/wardId: string`. `AddressesService` now persists `Address.provinceId/districtId/wardId`. Consumed by Task 5's `ShippingService` (reads `Address.district.ghnId`/`Address.ward.ghnCode`).

- [ ] **Step 1: Update `CreateAddressDto`**

Replace the `province`/`district`/`ward` fields in `src/modules/addresses/dto/create-address.dto.ts`:

```ts
import { ApiProperty } from '@nestjs/swagger';
import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  VN_PHONE_INVALID_MESSAGE,
  VN_PHONE_REGEX,
} from '../../../common/utils/phone.util';

export class CreateAddressDto {
  @ApiProperty()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  receiverName: string;

  @ApiProperty()
  @IsString()
  @Matches(VN_PHONE_REGEX, { message: VN_PHONE_INVALID_MESSAGE })
  phone: string;

  @ApiProperty({ description: 'id tỉnh/thành phố (GET /locations/provinces)' })
  @IsString()
  @IsNotEmpty()
  provinceId: string;

  @ApiProperty({ description: 'id quận/huyện (GET /locations/districts)' })
  @IsString()
  @IsNotEmpty()
  districtId: string;

  @ApiProperty({ description: 'id phường/xã (GET /locations/wards)' })
  @IsString()
  @IsNotEmpty()
  wardId: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  detail: string;

  @ApiProperty({
    required: false,
    description:
      'Đặt làm mặc định — địa chỉ đầu tiên của tài khoản luôn tự động là mặc định dù không truyền field này.',
  })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}
```

- [ ] **Step 2: Update `UpdateAddressDto`**

Replace the equivalent fields in `src/modules/addresses/dto/update-address.dto.ts`:

```ts
import { ApiProperty } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  VN_PHONE_INVALID_MESSAGE,
  VN_PHONE_REGEX,
} from '../../../common/utils/phone.util';

// Không có field isDefault ở đây — đặt mặc định là 1 hành động riêng (PATCH :id/default),
// tránh 1 endpoint làm 2 việc (sửa thông tin + đổi mặc định) và tránh vô tình bỏ mặc định
// khi client chỉ định gửi thiếu field.
export class UpdateAddressDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  receiverName?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @Matches(VN_PHONE_REGEX, { message: VN_PHONE_INVALID_MESSAGE })
  phone?: string;

  @ApiProperty({ required: false, description: 'id tỉnh/thành phố' })
  @IsOptional()
  @IsString()
  provinceId?: string;

  @ApiProperty({ required: false, description: 'id quận/huyện' })
  @IsOptional()
  @IsString()
  districtId?: string;

  @ApiProperty({ required: false, description: 'id phường/xã' })
  @IsOptional()
  @IsString()
  wardId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  detail?: string;
}
```

- [ ] **Step 3: Add chain validation + switch fields in `AddressesService`**

Edit `src/modules/addresses/addresses.service.ts` — add a private helper and call it from both `createAddress` and `updateAddress`, and change the `data` blocks to use the new fields:

```ts
  createAddress(userId: string, dto: CreateAddressDto): Promise<Address> {
    return this.runSerializable(async (tx) => {
      await this.validateLocationChain(dto.provinceId, dto.districtId, dto.wardId);

      const count = await tx.address.count({ where: { userId } });
      if (count >= this.MAX_ADDRESSES_PER_USER) {
        throw new BadRequestException(
          `Chỉ được lưu tối đa ${this.MAX_ADDRESSES_PER_USER} địa chỉ.`,
        );
      }

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
      });
    });
  }

  async updateAddress(
    userId: string,
    addressId: string,
    dto: UpdateAddressDto,
  ): Promise<Address> {
    const existing = await this.findOwned(this.prisma, userId, addressId);

    const provinceId = dto.provinceId ?? existing.provinceId;
    const districtId = dto.districtId ?? existing.districtId;
    const wardId = dto.wardId ?? existing.wardId;
    if (dto.provinceId || dto.districtId || dto.wardId) {
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
    });
  }
```

Add the private helper near `findOwned`/`runSerializable`:

```ts
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
```

- [ ] **Step 4: Build**

Run: `pnpm --filter @clothing-shop/be build`
Expected: PASS.

- [ ] **Step 5: Manual smoke test**

Run: `pnpm start:dev`. Using Swagger (`/api/docs`) or curl with a JWT: `POST /addresses` with a `districtId` that doesn't belong to the given `provinceId` → expect 400. With a valid chain (get real ids from `/locations/provinces` → `/locations/districts` → `/locations/wards`) → expect 201 with the new address.

- [ ] **Step 6: Commit**

```bash
git add src/modules/addresses
git commit -m "feat(addresses): switch province/district/ward to location ids"
```

---

### Task 4: `GhnClient`

**Files:**
- Create: `src/common/ghn/ghn-client.service.ts`
- Create: `src/common/ghn/ghn.module.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces: `GhnClient.post<T>(path: string, body: Record<string, unknown>): Promise<T>` — throws `InternalServerErrorException` on missing config or non-2xx GHN response. Consumed by Task 5's `ShippingService`.

- [ ] **Step 1: Client**

Create `src/common/ghn/ghn-client.service.ts`:

```ts
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
```

- [ ] **Step 2: Module**

Create `src/common/ghn/ghn.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { GhnClient } from './ghn-client.service';

@Module({
  providers: [GhnClient],
  exports: [GhnClient],
})
export class GhnModule {}
```

- [ ] **Step 3: Env vars**

Append to `.env.example`:

```
# GHN — tính phí ship (khachhang.ghn.vn). ShopId khác Token dùng cho master-data sync bên
# backend-cms — endpoint /v2/shipping-order/* bắt buộc có ShopId.
GHN_API_TOKEN=""
GHN_API_BASE_URL="https://dev-online-gateway.ghn.vn/shiip/public-api"
GHN_SHOP_ID=""
# Quận/phường nơi shop gửi hàng (điểm "from" khi tính phí) — 1 shop 1 kho, cấu hình tĩnh.
GHN_FROM_DISTRICT_ID=""
GHN_FROM_WARD_CODE=""
```

Add the same 5 keys with real dev values to your local `.env` (not committed).

- [ ] **Step 4: Build**

Run: `pnpm --filter @clothing-shop/be build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/common/ghn .env.example
git commit -m "feat(ghn): add GHN HTTP client for shipping fee calls"
```

---

### Task 5: `shipping` module

**Files:**
- Create: `src/modules/shipping/dto/shipping-fee-query.dto.ts`
- Create: `src/modules/shipping/shipping.service.ts`
- Create: `src/modules/shipping/shipping.controller.ts`
- Create: `src/modules/shipping/shipping.module.ts`
- Modify: `src/app.module.ts`

**Interfaces:**
- Consumes: `GhnClient.post` (Task 4), `Address.provinceId/districtId/wardId` + `district.ghnId`/`ward.ghnCode` relations, `ProductVariant.weight` (Task 1 in `backend-cms`, via Task 1 submodule bump here).
- Produces: `GET /shipping/fee?addressId=` → `ShippingFeeOption[]` where `ShippingFeeOption = { serviceId: number, serviceTypeId: number, name: string, fee: number, expectedDeliveryTime: string }`. `ShippingService.getFeeQuote(userId: string, addressId: string): Promise<ShippingFeeOption[]>` — consumed by Task 6's tests.

- [ ] **Step 1: Query DTO**

Create `src/modules/shipping/dto/shipping-fee-query.dto.ts`:

```ts
import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class ShippingFeeQueryDto {
  @ApiProperty({ description: 'id địa chỉ đã lưu (GET /addresses)' })
  @IsString()
  @IsNotEmpty()
  addressId!: string;
}
```

- [ ] **Step 2: Service**

Create `src/modules/shipping/shipping.service.ts`:

```ts
import {
  BadRequestException,
  Injectable,
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
      throw new BadRequestException(
        'Giỏ hàng trống, không thể tính phí ship.',
      );
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

    const services = await this.ghnClient.post<GhnAvailableService[]>(
      '/v2/shipping-order/available-services',
      {
        shop_id: Number(this.config.get<string>('GHN_SHOP_ID', '0')),
        from_district: fromDistrictId,
        to_district: toDistrictId,
      },
    );

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
  }
}
```

- [ ] **Step 3: Controller**

Create `src/modules/shipping/shipping.controller.ts`:

```ts
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { ShippingService } from './shipping.service';
import { ShippingFeeQueryDto } from './dto/shipping-fee-query.dto';

@ApiTags('shipping')
@ApiBearerAuth()
@Controller('shipping')
@UseGuards(JwtAuthGuard)
export class ShippingController {
  constructor(private readonly shippingService: ShippingService) {}

  @Get('fee')
  @ApiOperation({
    summary:
      'Tính phí ship + gói cước + thời gian giao dự kiến theo địa chỉ đã lưu và giỏ hàng hiện tại',
  })
  getFeeQuote(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ShippingFeeQueryDto,
  ) {
    return this.shippingService.getFeeQuote(user.id, query.addressId);
  }
}
```

- [ ] **Step 4: Module**

Create `src/modules/shipping/shipping.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { ShippingController } from './shipping.controller';
import { ShippingService } from './shipping.service';
import { GhnModule } from '../../common/ghn/ghn.module';

@Module({
  imports: [GhnModule],
  controllers: [ShippingController],
  providers: [ShippingService],
})
export class ShippingModule {}
```

- [ ] **Step 5: Register in `AppModule`**

Edit `src/app.module.ts`:

```ts
import { ShippingModule } from './modules/shipping/shipping.module';
```

```ts
    LocationsModule,
    ShippingModule,
```

- [ ] **Step 6: Build**

Run: `pnpm --filter @clothing-shop/be build`
Expected: PASS.

- [ ] **Step 7: Live smoke test against GHN's sandbox**

The field names in `GhnAvailableService`/`GhnFeeResponse`/`GhnLeadtimeResponse` (Step 2) are written from GHN's published `v2/shipping-order/*` API contract, but this repo has no automated way to verify them against the live API — confirm manually once sandbox credentials exist:

1. Register a GHN sandbox shop at `https://khachhang.ghn.vn` (dev environment) if not already done, get `Token` + `ShopId`, fill the real values into your local `.env` (`GHN_API_TOKEN`, `GHN_SHOP_ID`, `GHN_FROM_DISTRICT_ID`, `GHN_FROM_WARD_CODE` — the last two come from the shop's registered pickup address in the GHN dashboard).
2. Run `pnpm start:dev`.
3. Add an item to a test user's cart (`POST /cart/items`) using a variant that has `weight` set (Task 1 in `backend-cms` requires it for new variants).
4. Create an address for that user (`POST /addresses`) with a real district/ward reachable by GHN.
5. `GET /shipping/fee?addressId=<id>` with that user's JWT. Expected: 200 with a non-empty array; each entry's `fee` and `expectedDeliveryTime` look sane (fee > 0, delivery time a few days out).
6. If GHN's response shape doesn't match (e.g. a renamed field), fix the `Ghn*Response` interfaces and the mapping in `getFeeQuote` in Step 2 before continuing.

- [ ] **Step 8: Commit**

```bash
git add src/modules/shipping src/app.module.ts
git commit -m "feat(shipping): add GHN fee/package/leadtime quote endpoint"
```

---

### Task 6: `ShippingService` unit tests

**Files:**
- Create: `src/modules/shipping/shipping.service.spec.ts`

**Interfaces:**
- Consumes: `ShippingService` (Task 5), constructed directly as `new ShippingService(prismaMock, ghnClientMock, configMock)` — matches this repo's existing hand-rolled-mock convention (see `backend-cms`'s `inventory.service.spec.ts` for the same pattern; this repo has no service-level spec yet, so this file also establishes the pattern here).

- [ ] **Step 1: Write the test file**

Create `src/modules/shipping/shipping.service.spec.ts`:

```ts
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
    const { prisma, addressFindUnique, cartFindFirst, ghnClient, post, config } =
      createMocks();
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
    const { prisma, addressFindUnique, cartFindFirst, ghnClient, config } =
      createMocks();
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
    const { prisma, addressFindUnique, cartFindFirst, ghnClient, post, config } =
      createMocks();
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
```

- [ ] **Step 2: Run the tests**

Run: `pnpm --filter @clothing-shop/be test -- shipping.service.spec.ts`
Expected: 5 passed, 0 failed.

- [ ] **Step 3: Full gate before PR**

Run: `pnpm --filter @clothing-shop/be lint` — expect 0 errors.
Run: `pnpm --filter @clothing-shop/be build` — expect PASS.
Run: `pnpm --filter @clothing-shop/be test` — expect all pass.

- [ ] **Step 4: Commit**

```bash
git add src/modules/shipping/shipping.service.spec.ts
git commit -m "test(shipping): cover fee quote happy path and error cases"
```
