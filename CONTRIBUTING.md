# Quy trình Git — backend-user

Repo này dùng Git Flow rút gọn, áp dụng chung cho cả 4 repo của hệ thống (`backend-user`, `backend-cms`, `frontend-website`, `frontend-admin`).

## Nhánh chính

| Nhánh | Vai trò |
|---|---|
| `main` | Luôn ở trạng thái production-ready. **Không commit thẳng lên `main`** — chỉ nhận merge từ `develop` (release định kỳ) hoặc `hotfix/*` (sửa khẩn cấp). |
| `develop` | Nhánh tích hợp — nơi các `feature/*`/`fix/*` merge vào trước khi release. |

## Nhánh làm việc

| Loại | Tách từ | Merge vào | Khi nào dùng |
|---|---|---|---|
| `feature/<mo-ta-ngan>` | `develop` | `develop` | Tính năng mới |
| `fix/<mo-ta-ngan>` | `develop` | `develop` | Sửa bug không khẩn cấp |
| `release/<version>` | `develop` | `main` + `develop` | Chuẩn bị release (chỉ bugfix nhỏ/changelog, không thêm tính năng mới) |
| `hotfix/<mo-ta-ngan>` | `main` | `main` + `develop` | Sửa lỗi khẩn cấp đang ảnh hưởng production |

Đặt tên branch dạng `<loại>/<mo-ta-kebab-case>`, ví dụ: `feature/customer-order-history`, `fix/refresh-token-expiry`.

## Pull Request

- Mọi thay đổi vào `develop`/`main` đều qua Pull Request, không push thẳng.
- PR cần mô tả ngắn gọn **why** (không chỉ liệt kê file đổi), và checklist đã chạy lint/build/test theo `CLAUDE.md`.
- Nếu team ≥ 2 người: bắt buộc ít nhất 1 reviewer approve trước khi merge.
- Merge bằng "Squash and merge" để lịch sử `develop`/`main` gọn gàng (mỗi PR = 1 commit).

## Commit message

Khuyến khích theo [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `refactor:`, `chore:`, `test:`.
Ví dụ: `feat: add order status filter for admin dashboard`.

## Bật branch protection trên GitHub (làm 1 lần, thủ công qua UI)

Vào repo trên GitHub → **Settings → Branches → Add branch ruleset** (hoặc "Add rule" ở giao diện cũ), áp dụng cho cả `main` và `develop`:

1. Require a pull request before merging
2. Require approvals: 1 (nếu có từ 2 người trở lên trong team)
3. Require status checks to pass before merging → chọn workflow CI (`.github/workflows/ci.yml`) sau khi đã thiết lập CI
4. (Khuyến nghị) Do not allow bypassing the above settings — áp dụng cả cho admin

## Môi trường dev

- Node version pin ở `.nvmrc` — chạy `nvm use` trước khi làm việc để tránh lệch version giữa các máy trong team.
- Cài đặt: `pnpm install` — chạy độc lập trong từng repo, **không** chạy từ thư mục cha (không còn là monorepo).
