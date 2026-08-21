import { orderConfirmationEmailTemplate } from './email.templates';

describe('orderConfirmationEmailTemplate', () => {
  it('render đủ mã đơn, sản phẩm, địa chỉ, phương thức thanh toán, tổng tiền', () => {
    const { subject, html } = orderConfirmationEmailTemplate({
      orderCode: 'DH20260821ABCDEF',
      totalAmount: 300000,
      shippingAddress:
        'Nguyễn Văn A - 0900000000 - 123 Đường ABC, Phường 1, Quận 1, TP. Hồ Chí Minh',
      paymentMethod: 'COD',
      items: [
        {
          productName: 'Áo thun basic',
          size: 'M',
          color: 'Đen',
          quantity: 2,
          priceAtPurchase: 150000,
        },
      ],
    });

    expect(subject).toBe('Xác nhận đơn hàng #DH20260821ABCDEF');
    expect(html).toContain('DH20260821ABCDEF');
    expect(html).toContain('Áo thun basic');
    expect(html).toContain('M');
    expect(html).toContain('Đen');
    expect(html).toContain('123 Đường ABC');
    expect(html).toContain('Thanh toán khi nhận hàng (COD)');
    expect(html).toContain('300.000');
    expect(html).toContain('150.000');
  });

  it('map đúng nhãn tiếng Việt cho các paymentMethod khác COD', () => {
    const cases: Array<[string, string]> = [
      ['VNPAY', 'Chuyển khoản qua VNPay'],
      ['MOMO', 'Ví MoMo'],
      ['STRIPE', 'Thẻ quốc tế (Stripe)'],
    ];
    for (const [paymentMethod, expectedLabel] of cases) {
      const { html } = orderConfirmationEmailTemplate({
        orderCode: 'DH20260821ABCDEF',
        totalAmount: 150000,
        shippingAddress: 'Nguyễn Văn A - 0900000000 - 123 Đường ABC',
        paymentMethod,
        items: [
          {
            productName: 'Áo thun basic',
            size: 'M',
            color: 'Đen',
            quantity: 1,
            priceAtPurchase: 150000,
          },
        ],
      });
      expect(html).toContain(expectedLabel);
    }
  });
});
