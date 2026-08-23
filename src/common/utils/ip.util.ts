// Local dev/một số proxy trả IP dạng IPv4-mapped-IPv6 ("::ffff:127.0.0.1") — VNPay yêu cầu
// vnp_IpAddr dạng IPv4 thuần, bỏ prefix này nếu có. Đặt ở common/utils (không phải trong
// payments.controller.ts) vì đây là logic format IP chung, không riêng gì payments — module
// nào cần vnp_IpAddr hay log IP khách cũng dùng lại được.
export function normalizeIpAddr(ip: string): string {
  return ip.startsWith('::ffff:') ? ip.slice('::ffff:'.length) : ip;
}
