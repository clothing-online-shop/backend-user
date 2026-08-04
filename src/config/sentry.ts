import * as Sentry from '@sentry/node';

let initialized = false;

// Gọi ở đầu main.ts, trước khi tạo Nest app — nếu thiếu SENTRY_DSN thì bỏ qua
// (dev local không bắt buộc phải có Sentry).
export function initSentry(): void {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? 'development',
    tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.2 : 0,
  });
  initialized = true;
}

export function captureException(exception: unknown): void {
  if (!initialized) return;
  Sentry.captureException(exception);
}
