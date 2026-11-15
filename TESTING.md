# Kiểm tra Veil Messenger

Ứng dụng chạy trên Cloudflare Workers, D1 và R2. Dữ liệu kiểm thử phải nằm trong database local của Wrangler.

1. Cài dependencies với npm install.
2. Áp dụng migration bằng npm run db:migrate:local.
3. Mở một terminal và chạy npx wrangler dev --ip 127.0.0.1 --port 8790.
4. Mở terminal thứ hai và chạy npm run test:smoke.
5. Chạy npm run test:syntax và npm run check để kiểm tra cú pháp và gói triển khai.
6. Chạy npm run test:browser để thử tạo hai tài khoản, gửi/nhận tin, tìm kiếm, lưu trữ, sửa hồ sơ, đăng xuất/đăng nhập và viewport di động trong Chrome/Edge. Đặt CHROME_PATH nếu trình duyệt không nằm trong vị trí cài đặt thông dụng.

Smoke test tạo ba người dùng riêng với tên ngẫu nhiên và kiểm tra đăng ký, đăng nhập, tìm người, tạo hội thoại riêng, chống gửi trùng, quyền đọc, trạng thái chưa đọc, lưu trữ, tắt thông báo, cập nhật hồ sơ, đăng xuất, CSRF và gửi/tải tệp trên R2 local.

Mỗi lần thay đổi schema, cần áp dụng migration mới. Trước khi triển khai chính thức, sao lưu dữ liệu D1; sau đó chạy npm run db:migrate:remote, rồi npm run deploy. Không dùng smoke test trên URL production.
