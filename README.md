# Veil Messenger trên Cloudflare

Repo này chạy toàn bộ ứng dụng trên một Cloudflare Worker:

- `public/`: giao diện HTML/CSS/JavaScript.
- `src/worker.js`: API đăng ký, đăng nhập, hội thoại, tin nhắn và gửi tệp.
- Cloudflare D1: người dùng, session, hội thoại và metadata tệp.
- Cloudflare R2: nội dung tệp đính kèm.
- `migrations/`: cấu trúc D1 có thể áp dụng bằng Wrangler.

Các luồng đã hỗ trợ: đăng ký, đăng nhập và đăng xuất; tìm tài khoản bằng username;
tạo hội thoại trực tiếp; gửi và nhận tin nhắn văn bản/tệp; tìm kiếm tin nhắn trên D1;
phân trang lịch sử; đánh dấu đã đọc; lưu trữ, bỏ lưu trữ, tắt thông báo cho từng
hội thoại; cập nhật tên hiển thị; giao diện sáng/tối. Giao diện đồng bộ bằng polling.

## Chức năng gửi tệp

- Nút `+`: chọn mọi loại tệp, tối đa 10 MB.
- Nút ảnh: chỉ chọn JPG, PNG, WebP hoặc GIF.
- Ảnh hiển thị ngay trong hội thoại; tệp khác hiển thị dưới dạng thẻ tải xuống.
- Chỉ thành viên của hội thoại đã đăng nhập mới tải được tệp.

## 1. Chuẩn bị Cloudflare lần đầu

Yêu cầu Node.js 20 trở lên và một tài khoản Cloudflare đã bật Workers, D1 và R2.

```bash
npm install
npx wrangler login
npx wrangler d1 create veil-db
npx wrangler r2 bucket create veil-attachments
```

Nếu tạo database mới, cập nhật `database_id` trong `wrangler.jsonc` bằng UUID do Cloudflare trả về. Repo hiện có ID D1 riêng, vì vậy chỉ thay khi chủ động dùng tài nguyên khác. Sau đó tạo bảng trên D1:

```bash
npm run db:migrate:remote
```

Có thể kiểm tra và triển khai thủ công:

```bash
npm run check
npm run deploy
```

## 2. Đưa repo lên GitHub

Tại thư mục chứa file `package.json`:

```bash
git init
git add .
git commit -m "Deploy Veil Messenger to Cloudflare"
git branch -M main
git remote add origin https://github.com/USERNAME/REPOSITORY.git
git push -u origin main
```

Không commit token Cloudflare, `.dev.vars`, `.env`, thư mục `node_modules` hoặc dữ liệu người dùng.

## 3. Kết nối GitHub với Cloudflare

1. Mở Cloudflare Dashboard → **Workers & Pages** → **Create application**.
2. Chọn **GitHub**, cấp quyền và chọn repo vừa đẩy lên.
3. Đặt tên Worker là `sms`, tương ứng với trường `name` trong `wrangler.jsonc`.
4. Root directory: `/` nếu các file của repo nằm ngay ở thư mục gốc.
5. Deploy command: `npx wrangler deploy`.
6. Lưu và triển khai. Mỗi lần push nhánh production, Cloudflare sẽ tự build và deploy.

D1 `veil-db` và R2 `veil-attachments` phải được tạo trước trong cùng tài khoản Cloudflare. Migration D1 cũng phải được chạy ít nhất một lần trước khi người dùng đăng ký.

## Chạy local

Sau khi đã thay D1 ID trong `wrangler.jsonc`:

```bash
npm install
npm run db:migrate:local
npm run dev
```

Wrangler dùng D1/R2 local khi chạy `wrangler dev`. Dữ liệu local không được đẩy lên production.

Để xác thực toàn bộ nghiệp vụ và giao diện trên máy phát triển, làm theo
[`TESTING.md`](./TESTING.md). Trước khi deploy bản nâng cấp vào hệ thống có dữ liệu,
sao lưu D1 rồi chạy `npm run db:migrate:remote` để áp dụng migration bổ sung
cho trạng thái đã đọc.

## Ghi chú bảo mật

- Mật khẩu được băm PBKDF2-SHA-256 với salt riêng; không lưu mật khẩu gốc.
- Session lưu bằng hash trong D1 và cookie `HttpOnly`, `SameSite=Strict`, `Secure` trên HTTPS.
- File được phát qua API có kiểm tra thành viên hội thoại; bucket R2 không cần public.
- Tin nhắn chưa mã hóa đầu cuối (E2EE). HTTPS bảo vệ dữ liệu khi truyền, không thay thế E2EE.
