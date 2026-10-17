# Bối cảnh dự án SAGA

Cập nhật: 2026-10-17. Xem mục **Trạng thái mới nhất** ở cuối tài liệu trước khi dùng các số liệu lịch sử bên dưới. Đối chiếu lại Git, dữ liệu và website ở đầu mỗi giai đoạn; các con số quét RSS thay đổi theo thời gian.

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

## Nhật ký trước khi PR #2 được merge

- Theo bối cảnh chủ dự án cung cấp: SAGA News Only V3 đã triển khai và lỗi phân trang một từ đã được xác nhận sửa trên website. Commit Editorial V4.1 `8cd8279` đã được kiểm chứng là tổ tiên của `origin/main`. Báo cáo lịch sử từng ghi 71 mục RSS, 7 mục đủ điều kiện, 4 bản thảo và 4 bài được xuất bản; đây không phải thống kê hiện tại. Website production chưa được kiểm tra độc lập trong giai đoạn này.
- `origin/main` mới nhất đã fetch ngày 2026-10-17 là `72fd8a2` (SAGA: publish verified news). Nhánh `feature/saga-news-repair-20261017` bắt đầu đúng tại commit này; các sửa đổi của giai đoạn này chỉ thuộc nhánh làm việc và **chưa merge hay triển khai production**. Một nhánh thử nghiệm cũ tách khỏi main gây xung đột khi mô phỏng merge, nên được giữ nguyên thay vì ghi đè.
- Manifest hiện ghi **12 bài news**, `newsOnly: true`, 14 shard. Kiểm tra trực tiếp các shard có 12 news và **203 lore lưu trữ**; `node scripts/lore-verify.mjs` xác nhận **0 lore được index** vào Reader.
- Bản sửa cục bộ đã mở lại tương tác Level bị CSS `pointer-events:none` chặn; cử chỉ chạm không bắt nhầm ô chọn. Trình duyệt desktop và giả lập cảm ứng 390×844 đã đổi Level, đổi số trang, truy cập Read/Words/Review. Nền giấy kem còn nguyên.
- Bản sửa trên nhánh nhận ảnh có giấy phép riêng trong chú thích `wp-caption` của Global Voices, chỉ chấp nhận liên kết giấy phép đầy đủ trong chú thích từng ảnh, giữ credit khi chia trang và để bài chữ nếu thiếu ảnh hợp lệ. Ảnh “fair use” hoặc chỉ có đường dẫn RSS/OpenGraph vẫn bị loại.
- Cổng QA và cổng chuyển bài vào Reader nay còn so khớp credit ảnh của trang đầu ở **cả ba Level** với chứng cứ ảnh của bản thảo; thiếu hoặc sai credit ở một Level sẽ chặn xuất bản.
- Bản sửa cục bộ tăng số feed chính trị/kinh tế/quốc tế, ưu tiên bài phù hợp, tối đa 8 yêu cầu Gemini/lượt và tối đa 4 bài xuất bản/lượt. Lần quét **không gọi Gemini** ngày 2026-10-17 thấy 122 URL ứng viên, 28 bài qua quyền văn bản, 22 bài chưa trùng bài đã xuất bản, trong đó 5 bài có ảnh có chứng cứ. Đây chưa phải bài đã qua Gemini/QA hoặc đã xuất bản.
- Sau phản hồi từ điện thoại, kiểm tra trực tiếp `saga.id.vn` ở khung 390×844 xác nhận nút Level trên production có `pointer-events:none`, vùng chạm rơi vào lớp đọc. Bản sửa trong PR #2 có `pointer-events:auto` và vùng chạm trúng ô Level; PR chưa merge nên production vẫn còn lỗi.
- Manifest production kiểm tra ngày 2026-10-17 ghi 12 news, 0 ảnh đã xác minh, cập nhật lúc 06:04:38 UTC. Nhánh làm việc đã bổ sung **1 ảnh hợp lệ** cho bài Global Voices về Telenor/Myanmar, dựa trên chú thích ảnh trong bài gốc và metadata của Wikimedia Commons xác nhận tác giả Bjoertvedt, CC BY-SA 4.0. 11 bài còn lại không tự nhận ảnh khi thiếu chứng cứ. Manifest nhánh hiện có 12 news, 1 ảnh và 0 lore trong Reader.
- Bộ đọc giấy phép đã được sửa để chấp nhận khoảng trắng đầu liên kết CC trong chú thích thực tế của Global Voices; cổng xuất bản giờ cập nhật đúng số ảnh có chứng cứ. Kiểm tra ảnh trong Reader cục bộ ở màn hình 390×844: ảnh tải xong, hiển thị, có credit và không mất văn bản.
- GitHub Actions ghi 3 lượt `SAGA Discover - automatic news` chạy thủ công thành công và **chưa ghi nhận lượt chạy theo lịch** tại thời điểm kiểm tra. Cấu hình hiện đặt lịch 6 giờ/lần; chưa có bằng chứng kho đã tự tăng đều sau mỗi lịch chạy. Sau khi merge cần theo dõi các lượt chạy `schedule` và số bài thực sự được xuất bản.
- `npm test`: 81/81 đạt. `npm run build`, `node scripts/lore-verify.mjs` và `git diff --check` đạt trên nhánh làm việc. Build hiện tạo lại index 12 bài; không có bài news mới được tạo bởi Gemini trong giai đoạn này.

## Các ghi chú lịch sử trước khi PR #2 được merge

1. Kho production vẫn có 12 news và 0 ảnh news vì PR chưa được merge. Nhánh PR đã có 1 ảnh được xác minh; phiên cục bộ không có `GEMINI_API_KEY`, nên chưa chạy Gemini thật và không thể tuyên bố 22 bài ứng viên sẽ được xuất bản. Sau khi merge, kiểm tra staging thật trên một dự án Gemini Free Tier, kết quả QA và số bài mới trước khi phát hành.
2. Workflow hiện có đường tự động commit/push catalog lên `main` **sau khi mã được merge**. Không chạy workflow xuất bản, push `main` hay triển khai Cloudflare trong phiên chưa được phê duyệt. Khi chuẩn bị phát hành, rà lại quyền GitHub Actions, secret, quota thực tế và log của một lượt chạy.
3. Bảo vệ các cổng chống nội dung bịa: yêu cầu chứng cứ nguồn, kiểm tra số liệu, bản quyền và bản thảo ba Level. Kiểm tra tự động không chứng minh hoàn toàn tính đúng của mọi câu; cần xem xét chất lượng biên tập các bài mẫu trước khi mở rộng tự động.
4. Duy trì kiểm thử phân trang linh hoạt, tính toàn vẹn văn bản, không lore, cử chỉ, từ vựng và ảnh có giấy phép. Sau mỗi thay đổi lớn, cập nhật mục này bằng số liệu và trạng thái Git mới; không ghi con số quét RSS như một bảo đảm lâu dài.

## Trạng thái mới nhất — 2026-10-17

- PR #2 đã merge vào `main` tại `b55087c`. Website production đã nhận bản sửa nút Level và ảnh có giấy phép của bài Telenor/Myanmar. Thử trực tiếp khung điện thoại 390×844 trên `saga.id.vn`: ô Level nhận chạm, ảnh tải đủ 800 px và hiển thị trong Reader.
- Lượt workflow chạy thủ công `39013505170` hoàn tất thành công, tạo commit `325ce50` và tăng kho production từ 12 lên **15 news**, vẫn **1 ảnh được xác minh** và **0 lore trong Reader**. Ba bài mới là tin Global Voices; không có ảnh với chứng cứ quyền sử dụng trong lượt này. Workflow có lịch 6 giờ/lần, nhưng đến lần kiểm tra này GitHub Actions mới ghi nhận các lượt thủ công, chưa có lượt `schedule`; không bảo đảm mỗi chu kỳ đều có bài mới hợp lệ.
- Reader ưu tiên bài chưa đọc, kiểm tra manifest khi kho ít, tiếp tục xoay vòng bài đã xuất bản khi hết bài mới. Thử trên production qua 15 lần chuyển bài: có 12 bài khác nhau trong kho lúc đó rồi tiếp tục đọc, không gặp màn hình trống. Đây là luồng đọc liên tục bằng bài thật có sẵn, không phải nguồn tin mới vô hạn.
- Người dùng phát hiện thanh chuyển trang che chữ trên điện thoại. Nguyên nhân ở `src/App.jsx`: news giữ các trang biên tập sẵn mà không đo chiều cao thật; khi mở phép đo cũ, điều kiện buộc đáy pager cao hơn đáy Reader 2 px dù flex đặt hai mép bằng nhau, gây trang một từ. Nhánh `fix/saga-mobile-pager-20261017` đo lại news theo từng Level và chấp nhận sai số bố cục 1 px ở đáy pager, trong khi vẫn bắt buộc chữ nằm trên pager 8 px. Mã này **chưa lên `main`/production** tại thời điểm ghi mục này.
- Kiểm tra cục bộ bài Telenor trên 390×844: A1–A2 có 4 trang, B1–B2 có 7, C1–C2 có 12; mọi từ nguyên vẹn, khoảng cách chữ đến pager tối thiểu 48 px và không có trang một từ. Khung 320×568, B1–B2 có 7 trang, khoảng cách tối thiểu 20 px, không có trang trống. Cần chạy lại bộ kiểm thử và build sau khi chốt nhánh, rồi kiểm tra preview và production sau phát hành.

### Việc tiếp theo

1. Hoàn tất kiểm thử nhánh sửa phân trang, tạo PR, merge khi đạt, xác nhận chính bài từng bị che chữ trên `saga.id.vn`.
2. Theo dõi một lượt workflow có sự kiện `schedule` thật; nếu lịch GitHub không chạy hoặc tin không tăng, chẩn đoán log/quota trước khi điều chỉnh. Giữ giới hạn Gemini, cổng QA và điều kiện bản quyền ảnh.
3. Mở rộng số ảnh bằng chứng cứ riêng cho từng ảnh ở bài mới; không tự lấy ảnh RSS/OpenGraph khi chưa rõ giấy phép. Theo dõi tỷ lệ bài có ảnh và chất lượng tin sau các lượt xuất bản.

## Xác nhận sau phát hành — 2026-10-17

- PR #3 đã merge vào `main` tại `a03e02d`; Cloudflare Workers Builds hoàn tất thành công và `saga.id.vn` đã tải bản JavaScript mới. Lỗi thanh chuyển trang che chữ trong bài Telenor/Myanmar đã hết trên production: ở khung 390×844, Level B1–B2 có 7 trang, khoảng cách chữ–pager tối thiểu 48 px, trang ngắn nhất 23 từ và toàn bộ văn bản giữ nguyên. Đổi sang A1–A2 tạo 4 trang, không tái hiện hàng trăm trang một từ.
- Thử luồng đọc trên production sau sửa: 18 lần chuyển bài, đi qua đủ 15 tựa khác nhau rồi tiếp tục đọc lại, không có màn hình trống. Kho production vẫn có **15 news, 1 ảnh có chứng cứ, 0 lore được index**. Ảnh Telenor hiển thị; bài thiếu ảnh hợp lệ vẫn giữ bố cục đọc chữ.
- Nhánh sửa đã qua 81/81 kiểm thử, `node scripts/lore-verify.mjs`, `npm run build`, `git diff --check`. Kiểm tra trước phát hành thêm khung 320×568: 7 trang B1–B2, khoảng cách tối thiểu 20 px và không có trang trống. Các kiểm tra trình duyệt là giả lập kích thước/cảm ứng, không thay thế thử trên mọi mẫu điện thoại thật.
- Chưa có bằng chứng lượt GitHub Actions kích hoạt bởi sự kiện `schedule`; lượt thủ công gần nhất đã tăng kho từ 12 lên 15. Cần theo dõi lượt theo lịch tiếp theo để xác nhận tăng trưởng tự động thực tế. Không thể hứa bài *mới* ở mọi lần vuốt: khi nguồn hoặc QA không tạo bài mới, Reader xoay vòng bài đã xuất bản.
