# SAGA: quy tắc làm việc cho Codex

Đọc [bối cảnh dự án](docs/SAGA_CONTEXT.md) trước khi sửa luồng đọc hoặc xuất bản. Repository này phục vụ SAGA, ứng dụng đọc tin tức thế giới bằng tiếng Anh tại https://saga.id.vn/.

## An toàn Git và phát hành

- Trước mỗi giai đoạn, kiểm tra remote, nhánh, `git status`, phần diff chưa commit và `origin/main` mới nhất. Giữ nguyên thay đổi của người dùng và của phiên trước; không reset, ghi đè hoặc xóa dữ liệu để giải quyết xung đột. Báo người dùng khi gặp xung đột chưa rõ cách xử lý.
- Làm việc trên nhánh riêng. Không push trực tiếp lên `main`, merge, chạy workflow xuất bản trên production hoặc triển khai Cloudflare nếu người dùng chưa phê duyệt.
- Không đưa tài liệu ngữ cảnh (`AGENTS.md`, `docs/SAGA_CONTEXT.md`, `README.md`) vào commit khi chưa được người dùng đồng ý. Không đưa staging report, khóa API hay nội dung báo gốc đã scrape vào Git.
- Sau một giai đoạn quan trọng, cập nhật `docs/SAGA_CONTEXT.md` bằng kết quả đã kiểm chứng, giới hạn và việc tiếp theo; phân biệt mã đang sửa cục bộ với mã đã có trên `main` và website.

## Phạm vi và chi phí làm việc

- Trước mỗi nhiệm vụ, xác định phạm vi từ yêu cầu và bối cảnh dự án hiện có; chỉ đọc những file liên quan. Chỉ mở rộng khảo sát repository khi bối cảnh không đủ hoặc có bằng chứng cần truy nguyên thêm.
- Không tự mở rộng nhiệm vụ hay thêm tính năng chưa được yêu cầu. Sửa lỗi đơn giản ở phần liên quan và chạy kiểm thử phù hợp; thay đổi ảnh hưởng nhiều chức năng phải chạy đầy đủ các kiểm thử cần thiết.
- Tái sử dụng kết quả kiểm tra còn hiệu lực; chỉ chạy lại khi mã, dữ liệu hoặc môi trường thay đổi có thể ảnh hưởng đến kết quả. Không bỏ kiểm thử, xác minh nguồn tin, bảo mật hoặc cổng kiểm soát quan trọng chỉ để tiết kiệm token.
- Mặc định tối đa hai vòng tự sửa sau khi phát hiện lỗi; nếu vẫn chưa đạt, báo nguyên nhân, phần đã kiểm chứng và đề xuất bước tiếp theo. Báo cáo cuối ngắn gọn: đã làm gì, kết quả kiểm thử, vấn đề còn lại và quyết định cần người dùng đưa ra nếu có.

## Hợp đồng sản phẩm

- Reader chỉ hiển thị bài thật với `contentType: "news"`. Giữ 203 bài lore cũ trong kho lưu trữ nhưng tuyệt đối không đưa chúng trở lại Reader.
- Ưu tiên chính trị thế giới, kinh tế toàn cầu và sự kiện quốc tế lớn; vẫn giữ đa dạng chủ đề. Không tạo tin, nguồn, số liệu hay trích dẫn không có chứng cứ.
- Mỗi bài news có ba Level A1–A2, B1–B2, C1–C2 độc lập. Bản đọc ngắn mục tiêu 4–6 trang trên khung điện thoại thông dụng, không cuộn dọc trong trang; điều chỉnh theo kích thước màn hình để không che chữ, không có trang một từ hoặc hàng trăm trang.
- Giữ nền giấy kem; vuốt ngang chuyển trang, vuốt dọc chuyển bài, đọc lại tin đã xuất bản khi hết tin mới. Bảo toàn Read, Words, Review, tra và lưu từ.
- Ảnh là tùy chọn. Chỉ dùng khi có chứng cứ quyền sử dụng của **từng ảnh**, ghi tác giả, giấy phép và liên kết nguồn; nếu không có thì trình bày bài chữ đẹp.
- Giữ cổng kiểm tra nguồn, bản quyền, độ trung thực và cấu trúc trước xuất bản. Mục tiêu chi phí vận hành là 0 đồng; giới hạn số lần gọi Gemini và dừng khi hết quota. Không coi kiểm tra tự động là bảo đảm tuyệt đối về sự thật.

## Bản đồ mã và kiểm tra

- Giao diện: `src/App.jsx`, `src/App.css`, `src/lib/`. Kho đang đọc: `public/lore-reader/manifest.json`, các shard JSON và `catalog-index.json`.
- Thu thập và biên tập: `scripts/discover-collect.mjs`, `scripts/discover/`. QA/xuất bản: `scripts/discover-live-qa.mjs`, `scripts/discover-publish.mjs`, `scripts/discover/bridge.mjs`, `scripts/build-reader-index.mjs`.
- Workflow tin tự động: `.github/workflows/saga-discover-publish.yml`. Workflow lore cũ trong `.github/workflows/daily-lore-library.yml` phải giữ ở trạng thái vô hiệu hóa.
- Trước bàn giao chạy `npm test`, `node scripts/lore-verify.mjs`, `npm run build`, `git diff --check`; kiểm tra trình duyệt trên desktop và khung điện thoại khi thay đổi giao diện.
