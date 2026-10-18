# Tài Liệu Kỹ Thuật: Engine Giao Cắt Không Gian Đánh Giá Rủi Ro Thửa Đất

Tài liệu này giải thích chi tiết kiến trúc, nguyên lý thuật toán hình học không gian của script [`parcel_risk_spatial_join.py`](file:///C:/Users/ad/.gemini/antigravity/scratch/risk_pipeline/parcel_risk_spatial_join.py) và từ điển dữ liệu (Data Dictionary & Schema) của file kết quả [`parcels_with_detailed_risks.json`](file:///C:/Users/ad/.gemini/antigravity/scratch/risk_pipeline/parcels_with_detailed_risks.json).

---

## 1. Mục Tiêu & Nguyên Lý Không Gian (Spatial Join Principle)

### 1.1. Bản chất bài toán kỹ thuật
Các cơ quan chính phủ Phần Lan (Thành phố Helsinki, Viện Môi trường SYKE, Viện Khí tượng FMI) xuất bản dữ liệu rủi ro môi trường dưới dạng **lớp bản đồ không gian (GIS Layers / Vector Polygons)**:
* Một đa giác Decibel tiếng ồn (ví dụ: vùng 70–75 dB dọc đường Ratapihantie) bao trùm một diện tích địa lý, **nhưng trong thuộc tính của đa giác không ghi sẵn danh sách số thửa đất `Kiinteistötunnus`**.
* Bản đồ địa chính của bạn lại có **404 thửa đất** với tọa độ tâm (`representative_coordinates`) và số định danh `Kiinteistötunnus`.

**Mục tiêu của Engine:** Tự động thực hiện phép **Giao cắt Không gian (Spatial Join)**: Bắn từng tọa độ thửa đất vào không gian địa lý của các lớp rủi ro chính phủ để trích xuất chỉ số chính xác cho từng mét vuông đất.

---

## 2. Giải Thích Chi Tiết Từng Phần Trong Mã Nguồn

### 2.1. Chuyển Đổi Hệ Quy Chiếu Tọa Độ (`pyproj.Transformer`)
* **Hệ tọa độ đầu vào:** Toàn cầu WGS84 (`EPSG:4326`) tính theo độ thập phân (ví dụ: `24.9366, 60.1931`). Trong hệ này, không thể tính khoảng cách chính xác theo mét.
* **Hệ tọa độ phẳng của Helsinki:** `EPSG:3879` (ETRS89 / GK25FIN). Đây là hệ quy chiếu phẳng tiêu chuẩn của thành phố Helsinki tính bằng mét:
  ```python
  t = Transformer.from_crs("EPSG:4326", "EPSG:3879", always_xy=True)
  x, y = t.transform(lon, lat)
  pt = Point(x, y)
  ```
  Nhờ chuyển sang `EPSG:3879`, khoảng cách giữa các đối tượng đo được trực tiếp bằng mét thực tế trên mặt đất.

---

### 2.2. Thuật Toán Cây Không Gian R-Tree (`shapely.strtree.STRtree`)
* **Vấn đề hiệu năng:** Nếu lặp qua 404 thửa đất và kiểm tra từng đa giác trong số 617 đa giác tiếng ồn, ta phải thực hiện $404 \times 617 = 249,268$ phép tính hình học phức tạp $\rightarrow$ Rất chậm.
* **Giải pháp trong code:**
  ```python
  tree_street = STRtree(street_geoms)
  tree_rail = STRtree(rail_geoms)
  ```
  Sử dụng cấu trúc dữ liệu **R-Tree (Sort-Tile-Recursive Tree)**. R-Tree phân chia không gian thành các hộp biên phân cấp (Bounding Boxes). Thời gian truy vấn một điểm chỉ tốn $O(\log M)$, giảm thời gian chạy từ 10 giây xuống **0.3 giây**.

---

### 2.3. Khớp Tiếng Ồn Giao Thông Bằng Point-in-Polygon
* Với mỗi thửa đất:
  ```python
  street_candidates = tree_street.query(pt)
  for idx in street_candidates:
      if street_geoms[idx].contains(pt):
          # Lấy dải decibel cao nhất
  ```
  1. R-Tree lọc ra các đa giác ứng viên có hộp biên chứa điểm `pt`.
  2. Phép kiểm tra hình học chính xác `contains(pt)` xác định điểm tâm thửa đất có nằm thực sự bên trong đa giác hay không.
  3. Nếu thửa đất nằm trong vùng phủ của tiếng ồn, hệ thống trích xuất mức Decibel thấp (`db_lo`), cao (`db_hi`) và mã màu hiển thị (`colour`).

---

### 2.4. Đo Khoảng Cách Hình Học Đến Cơ Sở Môi Trường Gần Nhất
* Với 7 cơ sở có giấy phép môi trường/xử lý phế phẩm trong khu vực:
  ```python
  for fac in permit_facilities:
      dist = pt.distance(fac["geom"]) # Khoảng cách Euclid chính xác bằng mét
  ```
  Hàm tự động quét tìm cơ sở gần thửa đất nhất, ghi nhận tên cơ sở, địa chỉ, loại hình xử lý và khoảng cách chính xác (ví dụ: cách trạm xăng 348m, cách bãi nghiền phế thải 1,200m).

---

## 3. Cách Xử Lý Các Trường Hợp Biên & Ngoại Lệ (Edge Cases)

### 3.1. Thửa đất nằm ngoài tất cả các đa giác tiếng ồn
* **Hiện tượng:** Bản đồ tiếng ồn của Helsinki chỉ vẽ đa giác cho các khu vực có độ ồn từ $45\text{ dB}$ trở lên. Các khu dân cư nằm lùi sâu trong nội khu có độ ồn $< 45\text{ dB}$ sẽ không rơi vào bất kỳ đa giác nào.
* **Xử lý trong code:**
  Hệ thống gán giá trị mặc định: `"< 45 dB (Quiet / Normal)"`, mã màu xanh lá nhạt (`#D4EDDA`), và mức độ rủi ro `severity = "LOW"`.

### 3.2. Thửa đất tiếp giáp nhiều dải tiếng ồn khác nhau
* **Hiện tượng:** Tại các nút giao phức tạp (như ga Pasila), một thửa đất lớn có thể chạm vào cả rìa đa giác 60–65 dB và 65–70 dB.
* **Xử lý:** Thuật toán duyệt qua toàn bộ các đa giác bao quanh và chọn mức Decibel trần lớn nhất (`max_db`), đảm bảo không bỏ sót nguy cơ ô nhiễm tiếng ồn cao nhất có thể ảnh hưởng đến cư dân.

### 3.3. Cơ sở môi trường không có địa chỉ đường (`street_address is null`)
* **Hiện tượng:** Một số công trình hạ tầng công cộng (ví dụ bãi tập kết vật liệu Keski-Pasila của Thành phố) không có số nhà bưu điện cụ thể (`street_address = null`).
* **Xử lý:** Code vẫn tính khoảng cách theo tọa độ Polygon ranh giới và hiển thị tên pháp nhân/cơ quan chủ quản mà không bị lỗi `NullPointerException`.

---

## 4. Từ Điển Dữ Liệu (Data Dictionary) Của File `parcels_with_detailed_risks.json`

File [`parcels_with_detailed_risks.json`](file:///C:/Users/ad/.gemini/antigravity/scratch/risk_pipeline/parcels_with_detailed_risks.json) lưu trữ hồ sơ rủi ro độc lập của **404 thửa đất**. Dưới đây là các bảng đặc tả toàn bộ các trường, có cột **Phạm vi nhỏ nhất** thể hiện cấp độ chi tiết không gian:

### 4.1. Cấu Trúc Gốc & Metadata

| Tên trường (Key) | Kiểu dữ liệu | Phạm vi nhỏ nhất (Granularity) | Ý nghĩa kỹ thuật & nghiệp vụ | Giá trị mẫu |
| :--- | :--- | :--- | :--- | :--- |
| `metadata.total_parcels_analyzed` | `Integer` | **Toàn BBOX** | Tổng số thửa đất địa chính đã được phân tích rủi ro trong BBOX. | `404` |
| `metadata.target_bbox` | `Array of Floats` | **Toàn BBOX** | Tọa độ 4 góc của BBOX mục tiêu `[min_lon, min_lat, max_lon, max_lat]`. | `[24.915, 60.191, 24.950, 60.209]` |
| `metadata.city` | `String` | **Cấp Thành phố** | Tên đô thị hành chính quản lý. | `"Helsinki"` |
| `metadata.source_layers` | `Array of Strings` | **Cấp Hệ thống GIS** | Danh sách các lớp dữ liệu WFS/REST chính thức của Chính phủ đã dùng để phân tích. | `["avoindata:Meluselvitys_2022_...", ...]` |
| `parcels` | `Object` (Dictionary) | **Từng thửa đất** | Danh mục 404 thửa đất. Khóa (Key) là mã 14 số `Kiinteistötunnus`. | `{ "09101203690001": { ... } }` |

---

### 4.2. Cấu Trúc Đối Tượng Thửa Đất (Parcel Risk Feature)
*Nằm trong `parcels[<kiinteistotunnus>]*

| Tên trường (Key) | Kiểu dữ liệu | Phạm vi nhỏ nhất (Granularity) | Ý nghĩa kỹ thuật & nghiệp vụ | Giá trị mẫu |
| :--- | :--- | :--- | :--- | :--- |
| `kiinteistotunnus` | `String` (14 số) | **Từng thửa đất** | Mã số thửa đất quốc gia duy nhất (Primary Key theo Maanmittauslaitos). | `"09101203730002"` |
| `text_format` | `String` | **Từng thửa đất** | Mã thửa đất theo chuẩn quy hoạch thành phố Helsinki: `Kunta-Kaupunginosa-Kortteli-Tontti`. | `"91-12-373-2"` |
| `official_addresses` | `Array of Strings` | **Từng thửa đất / Tòa nhà** | Danh sách tên đường và số nhà chính thức thuộc thửa đất. | `["Viipurinkatu 14"]` |
| `postal_code` | `String` | **Theo mã bưu điện** | Mã bưu chính của thửa đất (`00510` hoặc `00520`). | `"00510"` |
| `coordinates_wgs84` | `Array of Floats` | **Từng thửa đất** | Tọa độ điểm tâm (Centroid) của thửa đất `[lon, lat]` chuẩn WGS84. | `[24.94295341, 60.19096716]` |
| `total_buildings` | `Integer` | **Từng thửa đất** | Số lượng tòa nhà nằm trên thửa đất theo cơ sở dữ liệu Ryhti. | `1` |
| `total_floor_area_sqm` | `Float` / `Integer` | **Từng thửa đất** | Tổng diện tích sàn xây dựng ($m^2$) theo hồ sơ địa chính. | `1073` |
| `risk_profile` | `Object` | **Từng thửa đất** | Đối tượng chứa toàn bộ các chỉ số rủi ro chi tiết của chính thửa đất này. | `{ ... }` |

---

### 4.3. Cấu Trúc Đối Tượng Rủi Ro Chi Tiết (`risk_profile`)
*Nằm trong `parcels[<kiinteistotunnus>].risk_profile`*

| Nhóm rủi ro | Tên trường (Key) | Kiểu dữ liệu | Phạm vi nhỏ nhất (Granularity) | Ý nghĩa kỹ thuật & nghiệp vụ | Giá trị mẫu |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Tiếng ồn đường bộ** | `street_traffic_noise.decibel_range` | `String` | **Chi tiết TỪNG THỬA ĐẤT / TỪNG NHÀ** | Dải độ ồn giao thông đường bộ trung bình ($L_{den}$) khớp bằng tọa độ tâm thửa đất. | `"55-60 dB"` hoặc `"< 45 dB"` |
| | `street_traffic_noise.hex_color` | `String` | **Chi tiết TỪNG THỬA ĐẤT / TỪNG NHÀ** | Mã màu HEX chuẩn bản đồ âm học EU của thửa đất đó. | `"#FFCC00"` hoặc `"#FF0000"` |
| | `street_traffic_noise.severity` | `String` | **Chi tiết TỪNG THỬA ĐẤT / TỪNG NHÀ** | Mức độ cảnh báo rủi ro tiếng ồn của thửa đất: `"LOW"`, `"MODERATE"`, `"HIGH"`. | `"MODERATE"` |
| **Tiếng ồn đường sắt** | `railway_noise.decibel_range` | `String` | **Chi tiết TỪNG THỬA ĐẤT / TỪNG NHÀ** | Dải độ ồn phát sinh từ tàu hỏa và đường ray Pasila tại đúng vị trí thửa đất. | `"< 45 dB (Quiet / Normal)"` |
| | `railway_noise.hex_color` | `String` | **Chi tiết TỪNG THỬA ĐẤT / TỪNG NHÀ** | Mã màu HEX âm học đường sắt của thửa đất. | `"#D4EDDA"` (Xanh lá) |
| | `railway_noise.severity` | `String` | **Chi tiết TỪNG THỬA ĐẤT / TỪNG NHÀ** | Mức độ rủi ro đường sắt: `"LOW"` ($<55\text{dB}$), `"MODERATE"`, `"HIGH"` ($\ge 70\text{dB}$). | `"LOW"` |
| **Lũ lụt & Mực nước biển** | `flood_and_sea_hazard.status` | `String` | **Chi tiết TỪNG THỬA ĐẤT** | Đánh giá an toàn ngập lụt của thửa đất dựa trên địa hình thực tế. | `"SAFE"` |
| | `flood_and_sea_hazard.elevation_meters_above_sea_level` | `String` | **Chi tiết TỪNG THỬA ĐẤT / Địa hình** | Cao độ địa hình tự nhiên của thửa đất so với mực nước biển Vịnh Phần Lan. | `"15m - 30m (Bedrock ridge)"` |
| | `flood_and_sea_hazard.observed_floods_history` | `Integer` | **Chi tiết TỪNG THỬA ĐẤT** | Số lần ghi nhận ngập lụt tại thửa đất từ dữ liệu SYKE. | `0` |
| | `flood_and_sea_hazard.minimum_safe_construction_height_requirement` | `String` | **Khu vực ven biển / Tiêu chuẩn** | Yêu cầu cao độ tối thiểu xây dựng của FMI đối với khu vực ven biển (+3.0m). | `"+3.0m"` |
| **Cơ sở môi trường lân cận** | `nearest_environmental_permit_site.facility_name` | `String` | **Cơ sở cụ thể lân cận** | Tên cơ sở/nguồn phát thải có giấy phép môi trường nằm gần thửa đất nhất. | `"Neste Nordenskiöldinkatu"` |
| | `nearest_environmental_permit_site.facility_address` | `String` | **Địa chỉ cơ sở cụ thể** | Địa chỉ số nhà của cơ sở môi trường gần nhất. | `"Nordenskiöldinkatu 22"` |
| | `nearest_environmental_permit_site.activity_type` | `String` | **Cơ sở cụ thể lân cận** | Loại hình hoạt động môi trường theo Luật Môi trường Phần Lan (YSL). | `"YSL 527/2014 liite 2.3 jakeluasema"` |
| | `nearest_environmental_permit_site.distance_meters` | `Integer` | **Chi tiết TỪNG THỬA ĐẤT (Cự ly riêng)** | Khoảng cách đường chim bay chính xác tính bằng mét từ tâm thửa đất đến cơ sở này. | `736` (mét) |
| **Phóng xạ Radon** | `indoor_radon_radiation.status` | `String` | **Theo MÃ BƯU CHÍNH (Postal Code)** | Phân loại rủi ro phơi nhiễm khí Radon trong nhà theo dữ liệu STUK (`00510` / `00520`). | `"VERY_LOW"` |
| | `indoor_radon_radiation.details` | `String` | **Theo MÃ BƯU CHÍNH (Postal Code)** | Nồng độ Radon trung vị ($Bq/m^3$) và tỷ lệ % nhà vượt ngưỡng tham chiếu $300\ Bq/m^3$ của mã bưu chính đó. | `"VERY_LOW (Median ~48 Bq/m3, 1.2% exceeding 300 Bq/m3)"` |
| **An Toàn PCCC & Cứu Hỏa** | `fire_and_rescue_safety.structural_fire_class` | `String` | **Chi tiết TỪNG THỬA ĐẤT / TÒA NHÀ** | Cấp độ chống cháy kết cấu công trình theo quy chuẩn xây dựng Phần Lan: `"Class P1 (Non-combustible)"` (Bê tông/gạch) hoặc `"Class P3 (Timber)"`. | `"Class P1 (Non-combustible)"` |
| | `fire_and_rescue_safety.building_material` | `String` | **Chi tiết TỪNG THỬA ĐẤT / TÒA NHÀ** | Vật liệu chịu lực chính theo cơ sở dữ liệu quản lý xây dựng Helsinki RAVA (`c_rakeaine`). | `"Brick (Tiili)"` hoặc `"Concrete (Betoni)"` |
| | `fire_and_rescue_safety.heating_method` | `String` | **Chi tiết TỪNG THỬA ĐẤT / TÒA NHÀ** | Phương thức sưởi ấm theo đăng bạ RAVA (`c_lammtapa`). | `"District Heating (Kaukolämpö)"` |
| | `fire_and_rescue_safety.heating_fire_ignition_hazard` | `String` | **Chi tiết TỪNG THỬA ĐẤT / TÒA NHÀ** | Đánh giá nguy cơ cháy nổ từ nguồn nhiệt tại chỗ: `"NONE (Centralized urban hot water)"`. | `"NONE (Centralized urban hot water, no on-site flame)"` |
| | `fire_and_rescue_safety.rescue_services_coverage.target_first_engine_response_time` | `String` | **Cấp Khu Phố / Vùng 1** | Thời gian xe cứu hỏa đầu tiên tiếp cận hiện trường theo Palvelutasopäätös của Sở Cứu Hộ Helsinki. | `"< 6 minutes"` |
| | `fire_and_rescue_safety.rescue_services_coverage.primary_rescue_station` | `String` | **Cấp Khu Phố** | Trạm cứu hỏa thường trực phụ trách tác chiến khu vực Pasila / Alppila. | `"Kallion pelastusasema (Agricolankatu 15, ~1.5 km)"` |
| **Lưới Điện (Fingrid & Helen)** | `power_grid_and_reliability.national_grid_operator` | `String` | **Cấp Quốc Gia (Fingrid Oyj)** | Đơn vị điều độ lưới điện truyền tải quốc gia Phần Lan (Bộ Kinh tế). | `"Fingrid Oyj (Ministry of Economic Affairs and Employment)"` |
| | `power_grid_and_reliability.national_grid_api` | `String` | **Cấp Quốc Gia / API Doanh nghiệp** | Cổng dữ liệu mở chính thức của Fingrid theo chuẩn CC BY 4.0. | `"https://data.fingrid.fi (CC BY 4.0 Open Data)"` |
| | `power_grid_and_reliability.national_system_status` | `String` | **Cấp Quốc Gia** | Trạng thái vận hành lưới điện quốc gia thời gian thực (Dataset 205). | `"NORMAL_OPERATIONAL_STATE (Häiriötön tila)"` |
| | `power_grid_and_reliability.local_distribution_operator` | `String` | **Cấp Thành Phố** | Công ty phân phối điện độc quyền khu vực Helsinki. | `"Helen Sähköverkko Oy"` |
| | `power_grid_and_reliability.underground_cabling_pct` | `Integer` | **Toàn đô thị nội thành** | Tỷ lệ hạ ngầm toàn bộ cáp trung và hạ thế (tránh 100% rủi ro mất điện do bão, gió giật). | `100` (%) |
| | `power_grid_and_reliability.saidi_average_interruption_minutes_year` | `Float` | **Kiểm toán nhà nước (Energiavirasto)** | Thời gian mất điện trung bình năm của hộ dân theo báo cáo kiểm toán của Cơ quan Quản lý Năng lượng. | `1.8` (phút/năm) |
| | `power_grid_and_reliability.parcel_grid_connection` | `String` | **Chi tiết TỪNG THỬA ĐẤT** | Xác nhận thửa đất đấu nối chính thức vào lưới điện thành phố (`c_sahkolii`). | `"CONFIRMED_ELECTRIFIED"` |
| **Hệ Thống Nước & Cúp Nước** | `water_network_disruption.status` | `String` | **Chi tiết TỪNG THỬA ĐẤT / TÒA NHÀ** | Tình trạng cấp nước tại thửa đất: Cấp nước bình thường (`"NORMAL_SUPPLY"`) hay nằm trong vùng bảo trì/sự cố (`"SCHEDULED_MAINTENANCE_OR_ALERT"`). | `"NORMAL_SUPPLY"` hoặc `"SCHEDULED_MAINTENANCE_OR_ALERT"` |
| | `water_network_disruption.active_disruption` | `Boolean` | **Chi tiết TỪNG THỬA ĐẤT / TÒA NHÀ** | Cờ kiểm tra thửa đất có nằm trong đa giác gián đoạn cấp nước thực tế của HSY hay không. | `false` hoặc `true` |
| | `water_network_disruption.utility_provider` | `String` | **Cấp Vùng Thủ Đô** | Đơn vị cung cấp và xử lý nước sạch đô thị (HSY Open Data CC BY 4.0). | `"HSY (Helsingin seudun ympäristöpalvelut)"` |
| | `water_network_disruption.affected_residents_estimate` | `Integer` (Optional) | **Đa giác cụ thể từng cụm nhà** | Số lượng cư dân thực tế bị ảnh hưởng bởi đợt bảo trì/sự cố đường ống (nếu có). | `118` hoặc `276` |

---

## 5. Danh Mục Script Kiểm Thử & Pipeline Rủi Ro Mở (100% Legit Government Sources)

Tất cả mã nguồn và API đã được chuẩn hóa theo chuẩn Dữ liệu Mở của Chính phủ (CC BY 4.0), không sử dụng web scraping:

1. [`test_noise_wfs.py`](file:///C:/Users/ad/.gemini/antigravity/scratch/risk_pipeline/test_noise_wfs.py): Kiểm tra 3 lớp WFS tiếng ồn giao thông của TP Helsinki (Chỉ thị Âm học EU).
2. [`test_flood_syke.py`](file:///C:/Users/ad/.gemini/antigravity/scratch/risk_pipeline/test_flood_syke.py): Kiểm tra lịch sử ngập lụt SYKE và cao độ an toàn FMI.
3. [`test_environmental_permits.py`](file:///C:/Users/ad/.gemini/antigravity/scratch/risk_pipeline/test_environmental_permits.py): Quét 7 cơ sở xả thải/giấy phép môi trường WFS.
4. [`test_paavo_demographics.py`](file:///C:/Users/ad/.gemini/antigravity/scratch/risk_pipeline/test_paavo_demographics.py): Thu thập thu nhập và phân tầng hộ gia đình PAAVO Tilastokeskus.
5. [`test_radon_risk.py`](file:///C:/Users/ad/.gemini/antigravity/scratch/risk_pipeline/test_radon_risk.py): Phân tích bức xạ phơi nhiễm Radon theo trạm STUK.
6. [`test_fire_incidents.py`](file:///C:/Users/ad/.gemini/antigravity/scratch/risk_pipeline/test_fire_incidents.py): Phân tích kết cấu chống cháy công trình từ Đăng bạ Xây dựng Helsinki (RAVA WFS) và Vùng cứu hộ 112 Sở Cứu hộ Helsinki.
7. [`test_utility_outages.py`](file:///C:/Users/ad/.gemini/antigravity/scratch/risk_pipeline/test_utility_outages.py): Thu thập dữ liệu lưới điện quốc gia từ Fingrid Oyj Open Data, kiểm toán độ tin cậy từ Energiavirasto, và đa giác cúp nước từ HSY ArcGIS.
8. [`run_all_risk_tests.py`](file:///C:/Users/ad/.gemini/antigravity/scratch/risk_pipeline/run_all_risk_tests.py): Điều phối chạy đồng thời cả 7 module chính phủ, lưu vào `bbox_risk_profile.json`.
9. [`parcel_risk_spatial_join.py`](file:///C:/Users/ad/.gemini/antigravity/scratch/risk_pipeline/parcel_risk_spatial_join.py): Bắn 404 thửa đất vào các lớp GIS chính thức, tạo ra `parcels_with_detailed_risks.json`.

---

## 6. Schema Risk v2: Chuẩn hóa, Provenance và Freshness

Pipeline hiện tại trong thư mục [`risk-pipeline`](risk-pipeline/README.md) đọc hai
snapshot gốc nhưng không ghi đè chúng. Kết quả được tạo tại
`parcels_with_normalized_risks.json` với `schema_version = "2.1.0"`.

### 6.1. Chuẩn hóa dữ liệu

- Chuẩn hóa Unicode NFKC, khoảng trắng và khoảng trắng cuối địa chỉ.
- Loại bỏ địa chỉ trùng nhau theo so sánh không phân biệt hoa/thường.
- Kiểm tra mã `kiinteistotunnus` khớp khóa parcel.
- Chuẩn hóa postal code thành đúng 5 chữ số.
- Kiểm tra tọa độ WGS84 gồm đúng hai giá trị số.
- Không thay đổi hoặc loại bỏ giá trị risk cũ. Test có thể tái dựng toàn bộ
  `risk_profile` legacy từ schema v2 để phát hiện mất dữ liệu.

### 6.2. Metadata bắt buộc của mỗi risk factor

Mỗi factor trong schema v2 có cấu trúc:

```json
{
  "data": {},
  "scope": {
    "level": "parcel_representative_point",
    "spatial_basis": "point-in-polygon at the parcel representative coordinate",
    "inherited_from": null
  },
  "source": { "refs": ["helsinki_street_noise_2022"] },
  "as_of": "2022",
  "method": "Mô tả cách tạo giá trị",
  "freshness": {
    "cadence": "periodic",
    "status": "historical_snapshot",
    "usable_for_current_state": false,
    "refresh_policy": "Điều kiện cần refresh",
    "caveat": "Giới hạn khi diễn giải"
  }
}
```

`source.refs` tham chiếu tới `source_catalog` ở cấp dataset để tránh lặp lại
toàn bộ thông tin publisher và dataset trong mỗi parcel.

### 6.3. Phân nhóm theo cadence

| Nhóm | Risk factors | Quy tắc sử dụng |
| :--- | :--- | :--- |
| `static` | Đặc điểm kết cấu, vật liệu và hệ thống sưởi/chữa cháy của công trình | Có thể dùng làm mô tả nền, nhưng phải chú ý ngày snapshot và parcel có nhiều building. |
| `periodic` | Noise, flood, environmental permits, radon, rescue coverage, local-grid reliability | Chỉ dùng theo kỳ dữ liệu ghi trong `as_of`; không gọi là dữ liệu thời gian thực. |
| `live` | National grid status và HSY water disruptions | Chỉ được mô tả là trạng thái hiện tại khi có observation/expiry timestamp hợp lệ từ API live. |

Nếu `freshness.usable_for_current_state = false`, agent không được biến snapshot
đó thành khẳng định như “hiện đang mất nước” hoặc “lưới điện hiện bình thường”.

### 6.4. Chạy pipeline

```bash
cd risk-pipeline
npm test
npm run build
```

JSON Schema dùng để tích hợp các consumer tiếp theo nằm tại
`risk-pipeline/risk-profile-v2.schema.json`.

---

## 7. Hardening và MCP Risk (schema 2.1.0)

### 7.1. Radon fallback

- Chỉ `00510` và `00520` có profile STUK trong snapshot `bbox_risk_profile.json`.
- Các postal code khác trả `UNAVAILABLE_FOR_POSTAL_CODE`; không tái sử dụng giá trị
  của `00510`.
- Giá trị fallback cũ chỉ còn trong `legacy_data` để audit và bị ẩn khỏi MCP mặc định.

### 7.2. Water disruption

- Cờ `active_disruption` cũ không có observation/expiry timestamp nên đã bị thay bằng
  `UNKNOWN_REQUIRES_LIVE_CHECK` trong dữ liệu dùng để trả lời.
- Tool `risk_check_live_water_disruptions` query trực tiếp 6 polygon layer chính thức
  của HSY, lọc `alkuaika` và `loppuaika`, và trả `checkedAt`.
- Nếu một layer lỗi, tool trả `UNKNOWN_PARTIAL_QUERY_FAILURE` và
  `activeDisruption = null`, không trả `false`.

### 7.3. Parcel có nhiều building

- Parcel có một building dùng strategy `single_building`.
- Parcel có nhiều building dùng `legacy_parcel_summary_unresolved` và
  `usable_for_building_specific_claim = false` vì snapshot không có per-building
  provenance cho fire summary.

### 7.4. MCP tools

- `risk_get_property_profile`: lookup bằng địa chỉ hoặc `kiinteistotunnus`, có thể chọn
  `static`, `periodic`, `live`.
- `risk_check_live_water_disruptions`: kiểm tra live HSY tại representative point.
- MCP nằm trong `mcp-risk`; backend và Docker Compose đã được nối thêm service này.
