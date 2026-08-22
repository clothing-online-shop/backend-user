import { buildSignedQuery, verifySignature } from './vnpay-signature.util';

const HASH_SECRET = 'TESTSECRETKEYFORLOCALDEVONLY123';

function parseQuery(query: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const pair of query.split('&')) {
    const [key, value] = pair.split('=');
    result[key] = decodeURIComponent(value.replace(/\+/g, '%20'));
  }
  return result;
}

describe('vnpay-signature.util', () => {
  const baseParams = {
    vnp_Version: '2.1.0',
    vnp_Command: 'pay',
    vnp_TmnCode: 'TESTCODE01',
    vnp_Amount: '10000000',
    vnp_CurrCode: 'VND',
    vnp_TxnRef: 'ORDABC123-XYZ',
    vnp_OrderInfo: 'Thanh toan don hang ORDABC123',
    vnp_OrderType: 'other',
    vnp_Locale: 'vn',
    vnp_ReturnUrl: 'http://localhost:3000/payment/return',
    vnp_IpAddr: '127.0.0.1',
    vnp_CreateDate: '20260820120000',
  };

  it('ký rồi verify lại đúng — roundtrip thành công', () => {
    const signedQuery = buildSignedQuery(baseParams, HASH_SECRET);
    const parsed = parseQuery(signedQuery);

    expect(parsed.vnp_SecureHash).toBeDefined();
    expect(verifySignature(parsed, HASH_SECRET)).toBe(true);
  });

  it('phát hiện chữ ký bị giả mạo (sửa 1 ký tự)', () => {
    const signedQuery = buildSignedQuery(baseParams, HASH_SECRET);
    const parsed = parseQuery(signedQuery);
    const tampered = {
      ...parsed,
      vnp_SecureHash: flipLastChar(parsed.vnp_SecureHash),
    };

    expect(verifySignature(tampered, HASH_SECRET)).toBe(false);
  });

  it('phát hiện dữ liệu bị sửa sau khi ký (đổi vnp_Amount)', () => {
    const signedQuery = buildSignedQuery(baseParams, HASH_SECRET);
    const parsed = parseQuery(signedQuery);
    const tampered = { ...parsed, vnp_Amount: '1' };

    expect(verifySignature(tampered, HASH_SECRET)).toBe(false);
  });

  it('sai hash secret thì verify luôn fail', () => {
    const signedQuery = buildSignedQuery(baseParams, HASH_SECRET);
    const parsed = parseQuery(signedQuery);

    expect(verifySignature(parsed, 'wrong-secret')).toBe(false);
  });

  it('thiếu vnp_SecureHash thì verify fail thay vì throw', () => {
    expect(verifySignature({ vnp_Amount: '1000' }, HASH_SECRET)).toBe(false);
  });
});

function flipLastChar(hash: string): string {
  const lastChar = hash.slice(-1);
  const replacement = lastChar === '0' ? '1' : '0';
  return hash.slice(0, -1) + replacement;
}
