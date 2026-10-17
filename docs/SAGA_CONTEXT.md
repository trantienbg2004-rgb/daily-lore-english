# Bối cảnh dự án SAGA

Cập nhật: 2026-10-17. Tài liệu này phân biệt **đã có trên `origin/main`** với **thay đổi của nhánh làm việc đang chờ duyệt**. Đối chiếu lại Git, dữ liệu và website ở đầu mỗi giai đoạn; các con số quét RSS thay đổi theo thời gian.

## Mục tiêu sản phẩm

SAGA (https://saga.id.vn/) là ứng dụng đọc tin tức thế giới bằng tiếng Anh, kết hợp học từ vựng, giao diện tối giản nền giấy kem. Nội dung ưu tiên chính trị thế giới, kinh tế toàn cầu và sự kiện quốc tế, đồng thời giữ sự đa dạng. Chỉ dùng tin thật có nguồn, không tạo tin giả, tôn trọng bản quyền và hướng đến chi phí vận hành 0 đồng.

Reader chỉ được nhận `contentType: "news"`. Ba Level A1–A2, B1–B2 và C1–C2 có nội dung, độ dài và số trang độc lập. Chia trang thích ứng với màn hình; giữ vuốt ngang chuyển trang, vuốt dọc chuyển bài, đọc lại tin khi hết bài mới. Read, Words, Review, tra/lưu từ và nền giấy kem là chức năng cốt lõi. Ảnh có thể vắng; chỉ hiển thị khi quyền của từng ảnh được chứng minh và ghi nguồn đầy đủ.

## Kiến trúc thực tế

| Thành phần | Vai trò |
| --- | --- |
| `src/App.jsx`, `src/App.css`, `src/lib/` | React Reader, Level, cử chỉ, phân trang, ảnh, từ vựng và lịch sử đọc. Từ đã lưu ở localStorage; lịch sử đọc dùng IndexedDB, có đường dự phòng. |
| `public/lore-reader/` | Manifest, các shard JSON và catalog index cho Reader. Chế độ `newsOnly` lọc lore cũ; các shard lore vẫn còn để phục hồi. |
| `scripts/discover-collect.mjs`, `scripts/discover/` | RSS → lọc trùng → lấy bài → kiểm tra quyền văn bản và từng ảnh → Gemini 2.5 Flash tạo ba Level. Báo cáo staging ở `reports/saga-discover-local/`, bị Git bỏ qua. |
| `scripts/discover-live-qa.mjs`, `scripts/discover-publish.mjs`, `scripts/discover/bridge.mjs` | Kiểm tra bản thảo, chỉ thêm bài hợp lệ, cập nhật manifest/index. Không dùng snippet hoặc ảnh RSS như bằng chứng bản quyền. |
| `.github/workflows/saga-discover-publish.yml` | Workflow 6 giờ một lần hoặc chạy thủ công, dùng GitHub secret `GEMINI_API_KEY`, kiểm thử, xuất bản và đẩy catalog sau khi mã đã được chấp nhận vào `main`. |
| `wrangler.jsonc` | Cấu hình Cloudflare dùng thư mục build `dist`. Workflow DAILY LORE cũ đã bị vô hiệu hóa. |

Nguồn hiện tại: Global Voices và VOA Learning English có thể vào bước xét quyền văn bản; BBC, NPR và The Conversation chỉ dùng metadata để khám phá, không tự đưa nội dung/ảnh của họ vào Reader. Các feed VOA đang cấu hình không có bài mới trong lần quét 2026-10-17. Global Voices có feed tổng cùng feed quan hệ quốc tế, kinh tế và chính trị trên nhánh cục bộ. Nội dung có dấu hiệu syndication hoặc thiếu giấy phép riêng bị chặn.

## Mốc và trạng thái đã kiểm chứng

- Theo bối cảnh chủ dự án cung cấp: SAGA News Only V3 đã triển khai và lỗi phân trang một từ đã được xác nhận sửa trên website. Commit Editorial V4.1 `8cd8279` đã được kiểm chứng là tổ tiên của `origin/main`. Báo cáo lịch sử từng ghi 71 mục RSS, 7 mục đủ điều kiện, 4 bản thảo và 4 bài được xuất bản; đây không phải thống kê hiện tại. Website production chưa được kiểm tra độc lập trong giai đoạn này.
- `origin/main` mới nhất đã fetch ngày 2026-10-17 là `72fd8a2` (SAGA: publish verified news). Nhánh `feature/saga-news-repair-20261017` bắt đầu đúng tại commit này; các sửa đổi của giai đoạn này chỉ thuộc nhánh làm việc và **chưa merge hay triển khai production**. Một nhánh thử nghiệm cũ tách khỏi main gây xung đột khi mô phỏng merge, nên được giữ nguyên thay vì ghi đè.
- Manifest hiện ghi **12 bài news**, `newsOnly: true`, 14 shard. Kiểm tra trực tiếp các shard có 12 news và **203 lore lưu trữ**; `node scripts/lore-verify.mjs` xác nhận **0 lore được index** vào Reader.
- Bản sửa cục bộ đã mở lại tương tác Level bị CSS `pointer-events:none` chặn; cử chỉ chạm không bắt nhầm ô chọn. Trình duyệt desktop và giả lập cảm ứng 390×844 đã đổi Level, đổi số trang, truy cập Read/Words/Review. Nền giấy kem còn nguyên.
- Bản sửa trên nhánh nhận ảnh có giấy phép riêng trong chú thích `wp-caption` của Global Voices, chỉ chấp nhận liên kết giấy phép đầy đủ trong chú thích từng ảnh, giữ credit khi chia trang và để bài chữ nếu thiếu ảnh hợp lệ. Ảnh “fair use” hoặc chỉ có đường dẫn RSS/OpenGraph vẫn bị loại.
- Cổng QA và cổng chuyển bài vào Reader nay còn so khớp credit ảnh của trang đầu ở **cả ba Level** với chứng cứ ảnh của bản thảo; thiếu hoặc sai credit ở một Level sẽ chặn xuất bản.
- Bản sửa cục bộ tăng số feed chính trị/kinh tế/quốc tế, ưu tiên bài phù hợp, tối đa 8 yêu cầu Gemini/lượt và tối đa 4 bài xuất bản/lượt. Lần quét **không gọi Gemini** ngày 2026-10-17 thấy 122 URL ứng viên, 28 bài qua quyền văn bản, 22 bài chưa trùng bài đã xuất bản, trong đó 5 bài có ảnh có chứng cứ. Đây chưa phải bài đã qua Gemini/QA hoặc đã xuất bản.
- `npm test`: 79/79 đạt. `npm run build`, `node scripts/lore-verify.mjs` và `git diff --check` đạt trên nhánh cục bộ. Build hiện tạo lại index 12 bài; không có nội dung mới được xuất bản.

## Vấn đề còn tồn tại và bước tiếp theo

1. Kho public vẫn có 12 news và chưa có ảnh news, vì các sửa đổi chưa được đưa vào nhánh phát hành. Phiên cục bộ không có `GEMINI_API_KEY`; không chạy Gemini thật, không thể tuyên bố 22 bài ứng viên sẽ được xuất bản. Khi được cho phép, kiểm tra staging thật trên một dự án Gemini Free Tier, kết quả QA và số bài mới trước khi phát hành.
2. Workflow hiện có đường tự động commit/push catalog lên `main` **sau khi mã được merge**. Không chạy workflow xuất bản, push `main` hay triển khai Cloudflare trong phiên chưa được phê duyệt. Khi chuẩn bị phát hành, rà lại quyền GitHub Actions, secret, quota thực tế và log của một lượt chạy.
3. Bảo vệ các cổng chống nội dung bịa: yêu cầu chứng cứ nguồn, kiểm tra số liệu, bản quyền và bản thảo ba Level. Kiểm tra tự động không chứng minh hoàn toàn tính đúng của mọi câu; cần xem xét chất lượng biên tập các bài mẫu trước khi mở rộng tự động.
4. Duy trì kiểm thử phân trang linh hoạt, tính toàn vẹn văn bản, không lore, cử chỉ, từ vựng và ảnh có giấy phép. Sau mỗi thay đổi lớn, cập nhật mục này bằng số liệu và trạng thái Git mới; không ghi con số quét RSS như một bảo đảm lâu dài.
