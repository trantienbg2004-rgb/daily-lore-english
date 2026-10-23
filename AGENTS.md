# SAGA: quy tắc làm việc cho Codex

Đọc [bối cảnh dự án](docs/SAGA_CONTEXT.md) trước khi sửa Reader hoặc quy trình xuất bản. SAGA tại https://saga.id.vn/ là ứng dụng đọc kiến thức thế giới bằng tiếng Anh theo hướng **Wikipedia-first**. Các ghi chép NEWS cũ trong tài liệu bối cảnh là lịch sử, không còn là hợp đồng sản phẩm hiện tại.

## An toàn Git và phát hành

- Trước mỗi giai đoạn, kiểm tra remote, nhánh, `git status`, diff chưa commit, `origin/main` và nhánh staging `feat/saga-wikipedia-first-20261020`. Bảo toàn thay đổi chưa commit, checkpoint và catalog; không reset, clean, force-push hoặc ghi đè để giải quyết xung đột.
- Làm việc trên nhánh riêng. Chỉ đưa thay đổi mã lên `main` qua PR; không merge, dispatch workflow xuất bản hay triển khai production khi chưa có phê duyệt cần thiết. Không tạo workflow cạnh tranh với `.github/workflows/saga-wiki-publish.yml`.
- Không commit `docs/SAGA_CONTEXT.md`, báo cáo staging, khóa API, secret hay toàn văn bản thảo chưa xuất bản. Có thể cập nhật `AGENTS.md` và hướng dẫn kỹ thuật để giữ đúng hợp đồng Wiki-first khi người dùng đã cho phép.
- Sau giai đoạn quan trọng, ghi kết quả đã kiểm chứng, giới hạn và việc tiếp theo trong `docs/SAGA_CONTEXT.md` cục bộ. Phân biệt mã staging, mã trên `main` và website production.

## Hợp đồng sản phẩm Wiki-first

- Chỉ dùng **English Wikipedia** làm nguồn dữ kiện. Mỗi bài gắn page ID và revision cụ thể. Biên tập thành narrative nonfiction có nguồn; không bịa người, ngày, số liệu, lời nói hoặc sự kiện. Không đưa NEWS hay 203 bài lore cũ vào feed Wiki.
- Kho mục tiêu tối thiểu **200 bài**, tối thiểu **15 bài trong mỗi** chủ đề Politics, Economy, Conflict & Security, Society, Culture, Science & Technology, Environment, Health, History & Geography, Sports. Đây là mục tiêu quy mô kho chung, **không phải 200 bài mới mỗi ngày**. `targetMet` chỉ đúng khi đạt cả hai ngưỡng; catalog ít hơn vẫn tiếp tục phục vụ bài hợp lệ.
- Mỗi bài có ba Level A1–A2, B1–B2, C1–C2 độc lập, mỗi Level mới 5 hoặc 6 trang; các Level có thể khác số trang. Văn phong hấp dẫn, dễ đọc theo CEFR, có mở đầu, diễn tiến và kết thúc; không kéo dài bằng câu lặp. Bài đã phát hành dài 7 trang vẫn được giữ nguyên và tiếp tục đọc được.
- Ảnh chỉ lấy từ **chính revision Wikipedia nguồn** và phải có chứng cứ quyền riêng cho từng ảnh, credit, giấy phép, liên kết file. Bài mới cần ảnh mở đầu hợp lệ; có thể thêm ảnh cùng bài nguồn vào các trang sau mà không đòi ảnh khớp ngữ cảnh văn bản của từng trang. Giữ caption gốc để người đọc biết ảnh thể hiện gì; không diễn giải ảnh tư liệu, bản đồ, biểu đồ hay mô phỏng thành chứng cứ về sự kiện khác. Bảo toàn các bài đã phát hành, kể cả bài cũ có trang mở đầu bằng chữ.
- Giữ giao diện Reader giấy kem, vuốt ngang chuyển trang, vuốt dọc chuyển bài, Words, Review, từ điển, lưu từ, lịch sử đọc và chuyển Level. Không gọi Gemini khi người dùng đọc.
- Giữ cổng nguồn, factual validation, biên tập, bản quyền ảnh và cấu trúc trước xuất bản. Chi phí vận hành **0 đồng**: chỉ dùng project/model đã xác nhận Free Tier, theo dõi lời gọi và token, tôn trọng 429/Retry-After, ngắt và thử lại có giới hạn khi 503. Dữ liệu usage không rõ phải ghi UNKNOWN. Kiểm tra tự động không bảo đảm tuyệt đối mọi câu đều đúng.

## Bản đồ mã và kiểm tra

- Reader: `src/App.jsx`, `src/App.css`, `src/lib/`. Kho đang phục vụ: `public/wiki-reader/manifest.json`, shard JSON và catalog index. News/lore cũ chỉ lưu trữ, không tự đưa lại vào feed Wiki.
- Thu thập, biên tập và ảnh: `scripts/wiki-pipeline.mjs`, `scripts/wiki/discovery.mjs`, `scripts/wiki/source.mjs`, `scripts/wiki/editor.mjs`, `scripts/wiki/media.mjs`, `scripts/wiki/runner.mjs`. QA/catalog: `scripts/wiki/catalog.mjs`, `scripts/wiki-promote.mjs`, `scripts/build-reader-index.mjs`.
- Workflow tự động: `.github/workflows/saga-wiki-publish.yml`. Nhánh staging giữ checkpoint và bản thảo để tiếp tục lượt sau; production chỉ nhận bài mới vượt cổng xác minh.
- Trước bàn giao chạy `npm test`, `npm run lint`, `node scripts/lore-verify.mjs`, `npm run build`, `git diff --check`. Kiểm tra website trên desktop và điện thoại khi sửa Reader. Tái sử dụng kết quả kiểm tra còn hiệu lực; không bỏ cổng quan trọng để tiết kiệm thời gian.
