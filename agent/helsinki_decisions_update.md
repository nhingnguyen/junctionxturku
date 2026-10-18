# Helsinki Decisions – Implementation Update

**Ngày cập nhật:** 18/10/2026
**Trạng thái:** Đã triển khai và kiểm thử end-to-end

## 1. Mục tiêu

Bổ sung khả năng tìm kiếm quyết định chính thức của Thành phố Helsinki và tự động liên kết nội dung quyết định với dữ liệu thửa đất, địa chỉ và công trình trong `bbox_parcels.json`.

Luồng mới giúp agent trả lời các câu hỏi như:

- Có quyết định nào liên quan đến một địa chỉ hoặc khu vực cụ thể?
- Quyết định có nhắc đến mã thửa đất nào?
- Thửa đất được nhắc đến có nằm trong snapshot cục bộ không?
- Trên thửa hiện có những công trình nào, xây năm bao nhiêu và có bao nhiêu diện tích sàn?

## 2. Kiến trúc đã triển khai

```text
Người dùng / Web chat
        |
        v
Backend Agent
        |
        +--> helsinki_search_decisions
        |        |
        |        +--> Helsinki Decisions API
        |        +--> Nhận diện mã thửa và địa chỉ
        |        +--> Ghép dữ liệu bbox_parcels.json
        |
        +--> helsinki_get_decision_context
        |        |
        |        +--> Lấy nội dung quyết định và phần căn cứ
        |        +--> Ghép thông tin thửa/công trình cục bộ
        |
        +--> helsinki_lookup_local_parcel
                 |
                 +--> Tra cứu trực tiếp snapshot cục bộ
```

## 3. MCP server mới

Module mới: `mcp-helsinki-decisions/`

Các file chính:

- `src/index.ts`: định nghĩa MCP server và các công cụ Decision.
- `src/parcel-index.ts`: đọc, chuẩn hóa và lập chỉ mục `bbox_parcels.json`.
- `package.json` và `package-lock.json`: dependency của MCP.
- `tsconfig.json`: cấu hình TypeScript.

### 3.1. `helsinki_search_decisions`

Tìm quyết định trong Helsinki Decisions API.

Input chính:

- `query`: từ khóa tìm kiếm, tối đa 300 ký tự.
- `language`: `fi` hoặc `sv`, mặc định `fi`.
- `limit`: từ 1 đến 10, mặc định 5.
- `offset`: hỗ trợ phân trang, tối đa 1000.

Output gồm:

- ID và mã hồ sơ của quyết định.
- Chủ đề, nhóm quyết định và đơn vị ban hành.
- Ngày họp và URL chính thức.
- Mã thửa được phát hiện trong nội dung.
- Các thửa khớp với snapshot cục bộ.
- Một đoạn trích ngắn từ phần quyết định.

Tìm kiếm sử dụng `operator: "and"`. Ví dụ, `maanvuokra Kluuvi` phải khớp cả hai ý thay vì trả về tất cả tài liệu chỉ chứa một trong hai từ.

### 3.2. `helsinki_get_decision_context`

Lấy chi tiết một quyết định bằng `decisionId` được trả về từ bước tìm kiếm.

Tool sẽ:

1. Gọi Helsinki Decisions API bằng ID chính xác.
2. Loại bỏ HTML không cần thiết.
3. Trích phần `Päätös` và `Perustelut` nếu có.
4. Nhận diện mã thửa và địa chỉ trong nội dung.
5. Ghép với dữ liệu thửa và công trình trong snapshot.

### 3.3. `helsinki_lookup_local_parcel`

Tra cứu trực tiếp dữ liệu cục bộ bằng:

- Mã thửa, ví dụ `91-12-369-1` hoặc `09101203690001`.
- Địa chỉ chính xác hoặc địa chỉ căn hộ/listing, ví dụ `Viipurinkatu 14 C 23`.

Mã thửa dạng có dấu gạch ngang được chuẩn hóa thành mã 14 chữ số trước khi tìm kiếm. Với địa chỉ căn hộ, tool ưu tiên khớp prefix địa chỉ chính thức dài nhất trong snapshot rồi loại staircase, số căn hộ, postcode và tên thành phố.

### 3.4. `helsinki_search_parcel_decisions`

Đây là tool parcel-first dành cho việc thẩm định một bất động sản. Người dùng có thể cung cấp mã thửa, địa chỉ hoặc cả hai.

Nếu chỉ có địa chỉ, tool chuẩn hóa địa chỉ và resolve mã thửa từ local snapshot. Nếu có nhiều thửa cùng khớp, tool trả `ambiguous_address` để người dùng chọn; nếu địa chỉ và mã thửa mâu thuẫn, tool dừng trước khi gọi API.

Sau khi resolve thành công, tool chạy **đúng hai search pass** với `type: "phrase"` và query được bọc dấu ngoặc kép:

1. `pass_1_parcel_id`: mã thửa dạng đọc được, ví dụ `"91-12-373-2"`.
2. `pass_2_address`: một địa chỉ chính thức đã chuẩn hóa, ví dụ `"Viipurinkatu 14"`.

Không thêm filter từ khóa nhà ở, khu vực hoặc keyword context vào hai pass này.

Kết quả từ các nhánh được deduplicate theo Decision ID và xếp hạng bằng bằng chứng deterministic. Mỗi candidate được gắn một trong các nhãn:

- `exact_parcel_and_address`: khớp cả mã thửa và địa chỉ; đã xác minh.
- `exact_parcel_id_only`: khớp chính xác mã thửa; đã xác minh.
- `address_match_only`: chỉ khớp địa chỉ; historical/high-confidence link nhưng chưa được xác minh bằng mã thửa.
- `broader_block_context`: chỉ có bằng chứng ở cấp block/kortteli.
- `unclassified`: API trả candidate nhưng nội dung nguồn không đủ bằng chứng deterministic.
- `conflict`: địa chỉ khớp nhưng tài liệu chứa mã thửa khác.

Mỗi nhãn đi kèm `verified`, `score`, field nguồn, giá trị khớp và đoạn evidence. Numeric score chỉ dùng để xếp hạng, không thay thế nhãn match.

Khi `limit` nhỏ hơn tổng số candidate, bộ chọn giữ representation của cả pass mã thửa và pass địa chỉ. Điều này tránh trường hợp các quyết định lịch sử chỉ có địa chỉ bị toàn bộ kết quả mã thửa có score cao hơn đẩy khỏi output.

## 4. Cách liên kết Decision với dữ liệu thửa đất

Thứ tự ưu tiên:

1. Tìm mã thửa trong nội dung quyết định bằng biểu thức nhận diện mã Phần Lan.
2. Chuẩn hóa mã thửa về dạng 14 chữ số.
3. Tìm mã đã chuẩn hóa trong local parcel index.
4. Nếu không có mã thửa phù hợp, thử khớp địa chỉ đã được chuẩn hóa.
5. Chỉ trả thông tin rút gọn cần thiết cho LLM.

Dữ liệu công trình được trả về gồm:

- Mã công trình vĩnh viễn.
- Năm hoàn thành.
- Số tầng.
- Diện tích sàn và tổng diện tích sàn.
- Mã mục đích sử dụng chính.
- Tọa độ đại diện.

## 5. Giới hạn dữ liệu và an toàn context

Các giới hạn đã áp dụng:

- Tối đa 10 quyết định cho mỗi lần tìm kiếm.
- Tối đa 60.000 ký tự cho một kết quả MCP gửi về agent.
- Tối đa 20.000 ký tự cho nội dung chi tiết của quyết định.
- Đoạn trích ở kết quả tìm kiếm được giới hạn khoảng 700 ký tự.
- Tối đa 20 công trình được trả về cho mỗi thửa.
- Tối đa 10 thửa được ghép từ một nội dung quyết định.
- Timeout gọi Helsinki Decisions API là 30 giây.
- Query, decision ID, địa chỉ và mã thửa đều có giới hạn độ dài input.

HTML thô từ Decisions API không được gửi trực tiếp vào context. Agent chỉ nhận metadata, phần quyết định/căn cứ đã làm sạch và dữ liệu thửa đã rút gọn.

## 6. Phạm vi của `bbox_parcels.json`

Snapshot hiện tại chứa:

- BBox WGS84: `[24.915, 60.191, 24.95, 60.209]`.
- 404 thửa đất.
- 703 công trình.
- Nguồn: Ryhti WFS/SYKE, các collection `open_building` và `open_address`.

Đây là snapshot giới hạn theo khu vực, không phải toàn bộ Helsinki và không phải sổ địa chính cập nhật theo thời gian thực.

Không tìm thấy một thửa trong snapshot **không có nghĩa là thửa đó không tồn tại**. Khi cần dữ liệu ngoài bbox, agent phải dùng Ryhti hoặc MML trực tiếp.

Snapshot cũng không chứa polygon ranh giới thửa. Geometry chính thức vẫn cần lấy từ MML bằng mã thửa.

## 7. Thay đổi trong backend và Docker

Backend đã đăng ký MCP server `helsinki-decisions` cùng với Ryhti và MML.

Các biến môi trường liên quan:

```env
HELSINKI_DECISIONS_API_URL=https://paatokset-elastic-proxy.api.hel.ninja/paatokset_decisions/_search
PARCEL_DATA_PATH=/app/data/bbox_parcels.json
```

Docker image hiện:

- Cài dependency của `mcp-helsinki-decisions`.
- Copy MCP mới vào image.
- Copy `bbox_parcels.json` vào `/app/data/bbox_parcels.json`.
- Mount source MCP và file JSON read-only trong môi trường Compose.

System prompt cũng đã được cập nhật để:

- Tìm Decision trước, sau đó mới lấy context của một quyết định cụ thể.
- Không tự suy đoán giá thuê, giá bán, ngày tháng, bên liên quan hoặc điều kiện pháp lý.
- Phân biệt diện tích sàn hiện hữu với diện tích đất và quyền xây dựng.
- Nói rõ khi dữ liệu chỉ đến từ snapshot giới hạn.

## 8. Cập nhật giao diện

Sidebar đã có thêm nguồn:

```text
Helsinki Decisions
Quyết định · Thuê đất · Quy hoạch
```

Phần hỏi nhanh đã có nút `Quyết định Helsinki`, cho phép chạy thử luồng tìm quyết định và kiểm tra thửa đất mà không cần nhớ tên MCP tool.

## 9. Cách chạy

Từ PowerShell:

```powershell
wsl bash -lc "cd /mnt/c/Project/Hackathon/junctionxturku && docker compose up --build"
```

Sau khi backend khởi động, mở:

```text
http://localhost:4000
```

Kiểm tra danh sách tool:

```powershell
curl.exe http://localhost:4000/tools
```

## 10. Câu hỏi kiểm thử đề xuất

### Tìm quyết định theo khu vực và chủ đề

```text
Tìm tối đa 3 quyết định Helsinki về maanvuokra tại Kluuvi, sau đó mở quyết định mới nhất.
```

### Tìm quyết định và ghép địa chỉ

```text
Tìm quyết định Helsinki liên quan Karjalankatu 2 và ghép với dữ liệu thửa đất cục bộ.
```

### Tìm từ địa chỉ căn hộ/listing

```text
Tìm toàn bộ quyết định cấp thành phố liên quan căn hộ tại Viipurinkatu 14 C 23.
```

Agent sẽ chuẩn hóa thành `Viipurinkatu 14`, resolve thửa `91-12-373-2`, rồi chạy hai pass theo mã thửa và địa chỉ.

### Tra cứu trực tiếp một thửa

```text
Tra thửa 91-12-369-1 trong local parcel snapshot và cho biết địa chỉ, năm xây dựng, số tầng và diện tích sàn hiện hữu.
```

## 11. Kết quả kiểm thử đã thực hiện

- Docker image build thành công.
- Docker Compose config hợp lệ.
- TypeScript check thành công cho backend, Ryhti MCP, MML MCP và Helsinki Decisions MCP.
- Backend đăng ký thành công tổng cộng 13 tools.
- `91-12-369-1` được chuẩn hóa thành `09101203690001`.
- Thửa mẫu trả về địa chỉ `Karjalankatu 2`, công trình hoàn thành năm 1960 và diện tích sàn hiện hữu 17.844 m².
- Truy vấn `maanvuokra Kluuvi` dùng điều kiện AND và trả về 6 kết quả tại thời điểm kiểm thử.
- Quyết định có địa chỉ trong bbox được ghép thành công với thông tin thửa và công trình cục bộ.
- Parcel-first search đã xác minh được cả `exact_parcel_id_only` và `exact_parcel_and_address` trên dữ liệu Helsinki thật.
- Bộ test có 17 cases cho chuẩn hóa địa chỉ over-specified, resolve prefix từ snapshot, đúng hai quoted phrase pass, bảo toàn kết quả từ cả hai pass khi giới hạn output, exact ID, ID + address, address conflict, block context, định dạng 14 chữ số và Unicode hyphen.
- Live API check với `91-432-1-26` và `Veturitie 1` xác nhận quoted phrase query hoạt động; tại thời điểm kiểm tra hai pass lần lượt báo 29 và 3 matches.
- Live MCP smoke test từ `Veturitie 1 A 2` resolve đúng về `Veturitie 1` / `09143200010026`; với `limit=3`, output gồm hai `exact_parcel_id_only` và một `address_match_only`.
- `buildingKey` nội bộ đã được loại khỏi dữ liệu compact gửi cho LLM; mã thửa và permanent building identifier vẫn được giữ để kiểm chứng nguồn.
- Decision search có retry cho lỗi tạm thời, cache trong RAM 5 phút và provenance cho từng query.

Số lượng kết quả Decisions có thể thay đổi khi dữ liệu của Thành phố Helsinki được cập nhật.

## 12. Hướng phát triển tiếp theo

1. Thêm bộ lọc ngày, loại quyết định, đơn vị ban hành và category.
2. Tạo job cập nhật snapshot Ryhti theo lịch thay vì dùng file tĩnh.
3. Lưu parcel index trong SQLite/PostGIS khi phạm vi dữ liệu lớn hơn.
4. Bổ sung resolver tên housing company (`Asunto Oy ...`) thành danh sách địa chỉ/mã thửa có evidence; không tự chọn khi có nhiều candidate.
5. Hiển thị vị trí thửa/công trình trên bản đồ.
6. Thêm integration test có mock Helsinki Decisions API cho toàn bộ dossier output.
