# Cart Stock Recheck Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `POST /cart/validate` — re-checks every line in the current user's cart against live stock/sale status, auto-fixes the cart (removes unavailable/out-of-stock lines, caps over-quantity lines to available stock), and reports what changed so the FE can warn the customer before checkout.

**Architecture:** One new method on the existing `CartService` plus one new route on the existing `CartController` — no new module, no schema change. Reuses the `MergeAdjustment` type and `toCartResponse`/`findMyCart` helpers already in `cart.service.ts`, following the exact per-line decision logic `mergeCart` already established (status check, then stock check), just applied to the cart's own existing rows instead of an incoming merge list.

**Tech Stack:** NestJS 11, Prisma 6, Jest.

**Spec:** [`docs/superpowers/specs/2026-08-19-cart-stock-recheck-design.md`](../specs/2026-08-19-cart-stock-recheck-design.md)

## Global Constraints

- 1 module = 1 domain, controller only calls service, business logic in `*.service.ts` (CLAUDE.md).
- Every DTO field needs `@ApiProperty()` — not applicable here, this endpoint takes no body.
- Inject `PrismaService`, never instantiate `PrismaClient` directly (CLAUDE.md).
- Routes needing login: `@UseGuards(JwtAuthGuard)`, current user via `@CurrentUser() user: AuthenticatedUser` (CLAUDE.md).
- Before opening a PR: `pnpm --filter @clothing-shop/be lint` (0 errors), `pnpm --filter @clothing-shop/be build` (passes), `pnpm --filter @clothing-shop/be test` (passes).
- Branch: `feature/cart-stock-recheck` (already created from `fix-develop`, spec doc already committed as `702e755`).

---

### Task 1: `POST /cart/validate`

**Files:**
- Modify: `src/modules/cart/cart.service.ts`
- Modify: `src/modules/cart/cart.controller.ts`
- Test: `src/modules/cart/cart.service.spec.ts` (new — no cart test file exists yet; establishes the pattern for this module, following the same hand-rolled-mock style already used in `backend-user`'s `shipping.service.spec.ts` and `backend-cms`'s `inventory.service.spec.ts`: `new CartService(prismaMock)`, no `Test.createTestingModule`)

**Interfaces:**
- Consumes: `MergeAdjustment` (already exported from `cart.service.ts`), `cartInclude`, `toCartResponse` (already defined at file scope in `cart.service.ts`), `ProductStatus` enum (`../products/product-status.enum`).
- Produces: `CartService.validateCart(userId: string): Promise<{ cart: ReturnType<typeof toCartResponse> | { id: null; items: []; subtotal: 0 }; adjustments: MergeAdjustment[] }>`. `POST /cart/validate` route.

- [ ] **Step 1: Write the failing tests**

Create `src/modules/cart/cart.service.spec.ts`:

```ts
import { CartService } from './cart.service';
import { PrismaService } from '../../config/prisma.service';
import { ProductStatus } from '../products/product-status.enum';

function createMocks() {
  const cartFindFirst = jest.fn();
  const cartItemDelete = jest.fn();
  const cartItemUpdate = jest.fn();
  const prisma = {
    cart: { findFirst: cartFindFirst },
    cartItem: { delete: cartItemDelete, update: cartItemUpdate },
  } as unknown as PrismaService;

  return { prisma, cartFindFirst, cartItemDelete, cartItemUpdate };
}

function cartItem(overrides: {
  id: string;
  productVariantId: string;
  quantity: number;
  stockQuantity: number;
  status?: ProductStatus;
}) {
  return {
    id: overrides.id,
    cartId: 'cart-1',
    productVariantId: overrides.productVariantId,
    quantity: overrides.quantity,
    productVariant: {
      id: overrides.productVariantId,
      price: { toNumber: () => 100000 },
      stockQuantity: overrides.stockQuantity,
      size: 'M',
      color: 'Đen',
      product: {
        id: 'product-1',
        name: 'Áo thun basic',
        slug: 'ao-thun-basic',
        thumbnail: null,
        status: overrides.status ?? ProductStatus.ACTIVE,
      },
    },
  };
}

describe('CartService.validateCart', () => {
  it('trả về giỏ trống, không có adjustment nếu user chưa có giỏ hàng', async () => {
    const { prisma, cartFindFirst } = createMocks();
    cartFindFirst.mockResolvedValue(null);
    const service = new CartService(prisma);

    const result = await service.validateCart('user-1');

    expect(result).toEqual({ cart: { id: null, items: [], subtotal: 0 }, adjustments: [] });
  });

  it('xóa dòng có sản phẩm ngừng bán (reason unavailable)', async () => {
    const { prisma, cartFindFirst, cartItemDelete } = createMocks();
    const item = cartItem({
      id: 'item-1',
      productVariantId: 'variant-1',
      quantity: 2,
      stockQuantity: 5,
      status: ProductStatus.INACTIVE,
    });
    cartFindFirst
      .mockResolvedValueOnce({ id: 'cart-1', items: [item] })
      .mockResolvedValueOnce({ id: 'cart-1', items: [] });
    const service = new CartService(prisma);

    const result = await service.validateCart('user-1');

    expect(cartItemDelete).toHaveBeenCalledWith({ where: { id: 'item-1' } });
    expect(result.adjustments).toEqual([
      {
        productVariantId: 'variant-1',
        requestedQuantity: 2,
        finalQuantity: 0,
        reason: 'unavailable',
      },
    ]);
  });

  it('xóa dòng hết hàng hẳn (reason out_of_stock)', async () => {
    const { prisma, cartFindFirst, cartItemDelete } = createMocks();
    const item = cartItem({
      id: 'item-1',
      productVariantId: 'variant-1',
      quantity: 2,
      stockQuantity: 0,
    });
    cartFindFirst
      .mockResolvedValueOnce({ id: 'cart-1', items: [item] })
      .mockResolvedValueOnce({ id: 'cart-1', items: [] });
    const service = new CartService(prisma);

    const result = await service.validateCart('user-1');

    expect(cartItemDelete).toHaveBeenCalledWith({ where: { id: 'item-1' } });
    expect(result.adjustments).toEqual([
      {
        productVariantId: 'variant-1',
        requestedQuantity: 2,
        finalQuantity: 0,
        reason: 'out_of_stock',
      },
    ]);
  });

  it('hạ số lượng dòng còn hàng nhưng không đủ (reason capped)', async () => {
    const { prisma, cartFindFirst, cartItemUpdate } = createMocks();
    const item = cartItem({
      id: 'item-1',
      productVariantId: 'variant-1',
      quantity: 5,
      stockQuantity: 2,
    });
    const itemAfter = cartItem({
      id: 'item-1',
      productVariantId: 'variant-1',
      quantity: 2,
      stockQuantity: 2,
    });
    cartFindFirst
      .mockResolvedValueOnce({ id: 'cart-1', items: [item] })
      .mockResolvedValueOnce({ id: 'cart-1', items: [itemAfter] });
    const service = new CartService(prisma);

    const result = await service.validateCart('user-1');

    expect(cartItemUpdate).toHaveBeenCalledWith({
      where: { id: 'item-1' },
      data: { quantity: 2 },
    });
    expect(result.adjustments).toEqual([
      {
        productVariantId: 'variant-1',
        requestedQuantity: 5,
        finalQuantity: 2,
        reason: 'capped',
      },
    ]);
    expect(result.cart.items[0].quantity).toBe(2);
  });

  it('giữ nguyên dòng còn đủ hàng, không có adjustment nào', async () => {
    const { prisma, cartFindFirst, cartItemDelete, cartItemUpdate } =
      createMocks();
    const item = cartItem({
      id: 'item-1',
      productVariantId: 'variant-1',
      quantity: 2,
      stockQuantity: 5,
    });
    cartFindFirst.mockResolvedValue({ id: 'cart-1', items: [item] });
    const service = new CartService(prisma);

    const result = await service.validateCart('user-1');

    expect(cartItemDelete).not.toHaveBeenCalled();
    expect(cartItemUpdate).not.toHaveBeenCalled();
    expect(result.adjustments).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @clothing-shop/be test -- cart.service.spec.ts`
Expected: FAIL — `validateCart` is not a function.

- [ ] **Step 3: Implement `validateCart` in `CartService`**

In `src/modules/cart/cart.service.ts`, add this method inside the `CartService` class (e.g. right after `mergeCart`, before the `private` helpers):

```ts
  // Rà soát toàn bộ giỏ hàng theo tồn kho/tình trạng bán HIỆN TẠI — dùng ngay trước khi
  // vào bước checkout. Cùng logic quyết định với mergeCart (status trước, tồn kho sau)
  // nhưng áp dụng cho các dòng ĐÃ CÓ trong giỏ, không phải danh sách merge vào.
  async validateCart(userId: string) {
    const cart = await this.prisma.cart.findFirst({
      where: { userId },
      include: cartInclude,
    });
    if (!cart) {
      return { cart: { id: null, items: [], subtotal: 0 }, adjustments: [] };
    }

    const adjustments: MergeAdjustment[] = [];

    for (const item of cart.items) {
      const status: ProductStatus = item.productVariant.product.status;
      if (status !== ProductStatus.ACTIVE) {
        adjustments.push({
          productVariantId: item.productVariantId,
          requestedQuantity: item.quantity,
          finalQuantity: 0,
          reason: 'unavailable',
        });
        await this.prisma.cartItem.delete({ where: { id: item.id } });
        continue;
      }

      const stockQuantity = item.productVariant.stockQuantity;
      if (stockQuantity === 0) {
        adjustments.push({
          productVariantId: item.productVariantId,
          requestedQuantity: item.quantity,
          finalQuantity: 0,
          reason: 'out_of_stock',
        });
        await this.prisma.cartItem.delete({ where: { id: item.id } });
        continue;
      }

      if (stockQuantity < item.quantity) {
        adjustments.push({
          productVariantId: item.productVariantId,
          requestedQuantity: item.quantity,
          finalQuantity: stockQuantity,
          reason: 'capped',
        });
        await this.prisma.cartItem.update({
          where: { id: item.id },
          data: { quantity: stockQuantity },
        });
      }
    }

    return { cart: await this.findMyCart(userId), adjustments };
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @clothing-shop/be test -- cart.service.spec.ts`
Expected: PASS, 5/5.

- [ ] **Step 5: Add the route**

In `src/modules/cart/cart.controller.ts`, add this method inside `CartController` (after `mergeCart`):

```ts
  @Post('validate')
  @ApiOperation({
    summary:
      'Rà soát tồn kho/tình trạng bán của giỏ hàng hiện tại trước khi checkout — tự xóa dòng hết hàng/ngừng bán, hạ số lượng dòng không đủ hàng',
  })
  validateCart(@CurrentUser() user: AuthenticatedUser) {
    return this.cartService.validateCart(user.id);
  }
```

- [ ] **Step 6: Build and lint**

Run: `pnpm --filter @clothing-shop/be build`
Expected: PASS.

Run: `pnpm --filter @clothing-shop/be lint`
Expected: 0 errors.

- [ ] **Step 7: Manual smoke test**

Run: `pnpm start:dev`. Using Swagger (`/api/docs`) with a logged-in user's JWT: add an item to the cart, then (via CMS or Prisma Studio) set that variant's `stockQuantity` to a value lower than the cart quantity, then call `POST /cart/validate` — expect the item's quantity capped and `adjustments` listing the `capped` reason. Set `stockQuantity` to 0 and call again — expect the item removed and `adjustments` listing `out_of_stock`.

- [ ] **Step 8: Run the full gate**

Run: `pnpm --filter @clothing-shop/be test` — expect all tests pass.

- [ ] **Step 9: Commit**

```bash
git add src/modules/cart/cart.service.ts src/modules/cart/cart.controller.ts src/modules/cart/cart.service.spec.ts
git commit -m "feat(cart): add POST /cart/validate to recheck stock before checkout"
```
