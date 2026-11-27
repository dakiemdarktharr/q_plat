# q_plat — đặc tả giao việc cho Codex

## Kích hoạt Goal trong Codex

Đặt file này trong workspace mà Codex được quyền đọc, hoặc gắn file vào thread. Gửi nguyên dòng sau như một slash command trong Codex:

```text
/goal Đọc toàn bộ Q_PLAT_CODEX_GOAL.md và hoàn thiện q_plat theo đặc tả. Chỉ hoàn thành khi người dùng nhập và kiểm định được edge riêng, trực quan hóa dữ liệu so với edge, toàn bộ hành trình nghiên cứu đã qua kiểm thử trên MongoDB Atlas thật và bản production Vercel, rồi bàn giao một index.html, một URL production Vercel và repo GitHub public đúng tên q_plat. Tự triển khai, nạp dữ liệu từ cloud, sửa lỗi và xác minh từng đầu ra. Không lưu dataset trên máy người dùng.
```

## 1. Mục tiêu và quyền thực hiện

Bạn là kỹ sư trưởng chịu trách nhiệm từ đầu đến cuối. Xây web app **q_plat** cho một quant researcher khám phá dataset, phát biểu giả thuyết, viết edge bằng code, tìm khi nào tín hiệu có sức dự báo và kiểm tra chi phí làm thay đổi kết quả bao nhiêu. Người dùng sẽ xem chính HTML được bàn giao, sau đó yêu cầu thay đổi UI/UX qua prompt tiếp theo. Tự quyết các chi tiết giao diện ban đầu. Lõi nghiên cứu, dữ liệu, backend và deployment phải đã hoạt động ở lần bàn giao đầu.

Bạn được yêu cầu tạo repo GitHub **public tên chính xác `q_plat`** trên tài khoản người dùng đã xác thực, push mã nguồn, cấu hình **một Vercel project cho production**, kết nối nó với repo và triển khai. Bạn cũng được yêu cầu tạo, cấu hình, điền connection string và seed MongoDB Atlas trên tài khoản người dùng được phép sử dụng. Dùng gói miễn phí hoặc quyền đã cấp hiện có. Kiểm tra owner/project trước mọi thao tác. Nếu cùng owner đã có repo hoặc project đúng yêu cầu, kiểm tra đó có phải công việc này rồi tiếp tục an toàn. Nếu trùng tên với dự án khác hay định công khai một repo riêng tư có nội dung sẵn, giữ nguyên và hỏi đúng một quyết định. Không tự đổi tên repo, ghi đè, force-push, mua gói, hoặc đưa secret lên Git.

Khảo sát công cụ và kết nối sẵn có, sau đó thực thi ngay. Chỉ yêu cầu người dùng thao tác khi thật sự cần đăng nhập/ủy quyền của nhà cung cấp hoặc xác nhận chi phí/phạm vi mới. Nêu đúng dịch vụ, đúng quyền thiếu và việc đang bị chặn, tiếp tục phần độc lập. Sau khi được cấp quyền, tự làm phần còn lại. Không yêu cầu người dùng tự dựng database, đi tìm URL, tự nạp dữ liệu, tự dán URI vào HTML hoặc tự deploy. Không coi một URL dự đoán, một trang tĩnh demo hay một checklist là bằng chứng hoàn thành.

## 2. Ba đầu ra và quy ước một file HTML

1. **Một file `index.html`** chứa frontend hoàn chỉnh, markup, CSS và JavaScript có thể đọc, tổ chức thành các vùng theme, layout, charts, interaction và API client. Dùng phần tử, CSS variables và component có tên dễ xác định cho lần chỉnh giao diện tiếp theo. Nếu dùng renderer biểu đồ, bundle inline phần cần thiết và giữ thông tin license. Không yêu cầu front-end build ở máy người dùng. HTML production và HTML tải về có nội dung tương đương từng byte sau giải nén HTTP. Cung cấp cách tải file trực tiếp từ production, ví dụ một nút dùng thuộc tính download hoặc route trả attachment cùng bytes. Không giao nhiều trang HTML hoặc bản mock riêng. Backend, tests và mã ingestion nằm trong repo.
2. **Một URL Vercel production ổn định** phục vụ chính HTML đó và API HTTPS cùng origin. Kiểm tra alias thực sự, build và Git commit đang phục vụ. Dùng cùng project/alias khi sửa UI theo prompt sau. Preview/test nội bộ có thể dùng trong quá trình xây. Chỉ bàn giao một URL ứng dụng. Không tự đoán tên miền từ tên repo.
3. **Một repo GitHub public tên `q_plat`**. Người chưa đăng nhập đọc được mã nguồn. Repo chứa đúng source để dựng lại app, lockfile, tests, schema/seed generator, importer và README ngắn. Repo chỉ chứa code, nguồn tham khảo và metadata kỹ thuật.

**Khi tôi mở file để xem giao diện:** bản tải về phải render được bố cục, editor, điều khiển và biểu đồ trên trình duyệt thông thường. Để bản xem có số liệu mà không nhúng dataset, cho phép HTML mở từ máy đọc một số series công khai được cấp quyền từ API production, theo viewport, qua endpoint read-only không mang credential. Thử trực tiếp việc mở `file://` trong Chromium. Nếu trình duyệt/khung xem tệp chặn kết nối mạng thì giữ bố cục, hiển thị lý do và nút mở **đúng màn hình** trên Vercel. Mọi luồng đọc/ghi và nghiên cứu riêng tư phải chạy trọn vẹn trong chính HTML khi được phục vụ qua production HTTPS. Giữ frontend một nguồn duy nhất; không biến file bàn giao thành một trang chỉ có link chuyển hướng. Giao diện ban đầu ưu tiên desktop, chart rõ đơn vị, bảng dễ đọc, keyboard focus và responsive. Tôi sẽ quyết định các thay đổi thẩm mỹ sau.

## 3. Kiến trúc, MongoDB và yêu cầu không lưu dataset trên máy tôi

- Kiến trúc tối thiểu là `index.html → /api cùng origin trên Vercel → MongoDB Atlas`. Tác vụ ingestion và tính toán chạy trên hạ tầng cloud. Có thể dùng TypeScript/Node với official MongoDB driver hoặc stack tương đương phù hợp Vercel. Dùng pool kết nối dùng lại giữa các invocation. Tách engine thuần khỏi HTTP handlers để có thể đối chiếu số bằng unit tests.
- Dùng connector/integration, Atlas CLI hoặc Admin API đã được người dùng ủy quyền. Lấy SRV host có thật, cấp database identity đặc thù chỉ truy cập database của app, tạo secret và nạp `MONGODB_URI` vào environment server-side của Vercel. Kiểm tra database ping và ghi/đọc bản ghi. Chỉ hiển thị tên dataset, snapshot và tình trạng kết nối trong UI. Provider management token khác với database credential. Dùng cách kết nối private/egress phù hợp gói hiện hữu. Kiểm tra networking của Vercel trước khi khóa allowlist; không tự mở quyền truy cập toàn Internet để chữa lỗi kết nối. Nếu integration cung cấp kết nối đã được ủy quyền thì ưu tiên dùng.
- Dữ liệu đi **nguồn → worker cloud → Atlas**. Parse stream hoặc buffer có giới hạn trong RAM của worker, kể cả khi giải nén ZIP; bulk write idempotent theo khóa ổn định. Sinh dữ liệu synthetic tại cloud từ seed. Kho dài hạn của ứng dụng cho dữ liệu, edge, run, kết quả và job là MongoDB. Không tải dataset về laptop; không tạo file CSV, JSON/JSONL chứa dữ liệu, Parquet, notebook có output, SQLite, dump Mongo, file snapshot hay volume Mongo local. Repo/test suite chỉ giữ code tạo fixture và các số kỳ vọng đơn lẻ. Tắt cache thư viện có thể ghi dataset. Không truyền toàn bộ panel xuống browser.
- API trả dữ liệu theo window/pagination có giới hạn, `Cache-Control: private, no-store` cho dữ liệu và kết quả, client fetch `cache: "no-store"`. Browser dùng RAM để vẽ; không ghi dataset vào localStorage, sessionStorage, IndexedDB, Cache Storage hay service worker. Có thể dùng cookie phiên HTTP-only để xác thực. Tránh log payload, download thư viện chứa dataset mẫu, HAR, trace và snapshot test chứa market rows trên máy người dùng. Bằng chứng kiểm thử là counts, hashes, small scalar assertions và test names. Chỉ kiểm tra workspace và storage do app sở hữu, không quét máy cá nhân.
- Tách dataset công khai đã có quyền hiển thị khỏi edge, ghi chú và run riêng của từng người. Dùng session xác thực hoặc định danh workspace an toàn, server enforce quyền với mọi API. Có cách để chủ sở hữu mở workspace thật trên production. Rate-limit validate/run/import theo người dùng, giới hạn thời gian, kích thước AST, panel, grid tham số và số job đồng thời. Ingestion chỉ dành cho owner/admin từ catalog URL đã xác minh. Không để visitor truy vấn tùy ý MongoDB hoặc tiêu quota nhập liệu.
- Cấu trúc gợi ý: datasets, dataset_versions, instruments, bars, observations, edges, edge_versions, runs, run_series, ledger_events, jobs. Normal index/unique compound index theo lựa chọn collection tương thích MongoDB, không dựa vào một document duy nhất cho mọi series. Dùng schema version, run hash, timestamps, checksum chuẩn hóa, trạng thái snapshot `staging → ready`. Retry nửa chừng không làm trùng bản ghi hoặc khiến người dùng đọc snapshot dở. Có thay đổi nội dung nguồn thì tạo version mới; run cũ giữ snapshot cũ.
- Dùng cơ chế job bền vững thực sự khả dụng với tài khoản Vercel. Job nhỏ có thể hoàn tất trong request có giới hạn, lưu kết quả trước khi trả. Job dài phải có dispatcher/worker cloud, checkpoint, timeout, lease/recovery, cancel/retry idempotent và trang theo dõi theo job ID. Không khởi chạy promise rồi trả HTTP và giả định process còn sống. Kiểm tra refresh hoặc đóng tab không làm mất job đã nhận. Tôn trọng quota thực của Atlas/Vercel; batch và downsample chart trước khi tăng tài nguyên.

## 4. Dữ liệu phải có trên MongoDB khi tôi mở app lần đầu

| Dataset | Yêu cầu nhập và công việc dùng để kiểm thử |
|---|---|
| **UCI Dow Jones Index**, dữ liệu thị trường thật | Nguồn của Michael Brown, 750 quan sát OHLCV **tuần** của 30 cổ phiếu trong nửa đầu 2011, CC BY 4.0. Tải từ nguồn chính thức trong worker cloud. Parse giá có ký hiệu tiền tệ, kiểm thời gian và ánh xạ mã. Dùng để xem nến tuần, viết edge, tính rank theo mặt cắt và chạy mô phỏng next-week-open. Kiểm đếm từ DB, nêu rõ dữ liệu price-only, giới hạn độ dài và universe của mẫu. |
| **ECB Euro foreign exchange reference rates**, chuỗi thực đa năm | Nạp ít nhất USD, GBP, JPY, CHF, CAD và AUD so với EUR, chọn một khoảng cố định nhiều năm có độ phủ tốt, chẳng hạn 2010–2024 để có phần chồng với UCI. Lưu chiều yết giá “đơn vị ngoại tệ trên một EUR”, tần suất, ngày quan sát, quy ước biết số liệu và nguồn. Dùng cho biểu đồ đối chiếu, nghiên cứu biến động/tương quan và kiểm tra join khác lịch. Đây là reference fixing; simulation mode ở đây là signal/forward-reference-return nghiên cứu, không cho chọn “khớp ở giá open” khi thiếu OHLC. |
| **Synthetic OHLCV có seed** | Tự sinh trên cloud khoảng 24–32 mã × 1.000–1.500 phiên; có nhóm ngành giả, regime, sự kiện thiếu giá, volume bằng 0, một mã niêm yết trễ và một fixture corporate action riêng. Ghi seed, generator_version, lịch và quy luật sinh. Có dataset tương quan đã biết hoặc null control để test, ghi rõ Synthetic ở mọi màn hình và report. |
| **Nguồn OHLCV thật dài hơn để nghiên cứu** | Ưu tiên nhập thêm một panel đa năm từ nguồn đủ quyền nếu tài khoản và điều kiện cho phép, chẳng hạn public spot daily CSV của CryptoDataDownload cho nghiên cứu phi thương mại, cùng venue và quote currency. Xác minh quyền hiển thị/nhập, ghi attribution, chủ nguồn, license và biến đổi. Nếu quyền công bố không rõ thì dùng workspace riêng có quyền thích hợp hoặc bỏ adapter tùy chọn, ghi trạng thái. Không dùng trả phí hoặc bịa ra OHLC. US Treasury daily par yield curve có thể thêm như feature vĩ mô; yield level không phải return của trái phiếu. |

Nguồn đưa thẳng cho importer và trang Data Catalog:

- UCI publisher, DOI và archive: https://archive.ics.uci.edu/dataset/312/dow%2Bjones%2Bindex · https://doi.org/10.24432/C5788V · https://archive.ics.uci.edu/static/public/312/dow%2Bjones%2Bindex.zip
- ECB API và điều kiện: https://data.ecb.europa.eu/help/api/data-examples · https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html · https://www.ecb.europa.eu/stats/ecb_statistics/governance_and_quality_framework/html/usage_policy.en.html
- Ví dụ request ECB có giới hạn: https://data-api.ecb.europa.eu/service/data/EXR/D.USD+GBP+JPY+CHF+CAD+AUD.EUR.SP00.A?startPeriod=2010-01-01&endPeriod=2024-12-31&format=csvdata
- Treasury XML: https://home.treasury.gov/treasury-daily-interest-rate-xml-feed
- CryptoDataDownload: https://www.cryptodatadownload.com/data/ · https://www.cryptodatadownload.com/terms-of-use/

**Điểm nghiệm thu bắt buộc.** UCI chứa sẵn `next_weeks_open`, `next_weeks_close`, `percent_change_next_weeks_price` và trường nhìn về cổ tức tương lai. Tầng feature của người dùng chỉ truy cập allowlist đã audit. Dựng forward labels riêng từ bars và chỉ dùng trong evaluator. Không gắn nhãn tuần là ngày, tự tạo volume cho tỷ giá, vẽ nến giả hoặc biểu diễn 25 tuần như một lịch sử đa năm. Nếu nguồn thật đổi endpoint, tìm endpoint chính thức thay thế, kiểm schema và license; đừng âm thầm thay bằng số ngẫu nhiên.

Trong catalog ghi asset class, field, kiểu, đơn vị, timezone, lịch, phạm vi, số mã, số bar, missingness, duplicate, giá điều chỉnh hay raw, revision/vintage, publication lag, snapshot checksum, nguồn và attribution. Phân biệt ngày quan sát, lúc công bố, lúc worker tải; nếu không biết ngày công bố lịch sử, khai báo proxy bảo thủ thay vì gắn nhãn point-in-time verified. Khi join hai tần suất, dùng as-of join theo thời điểm có thể biết, hiển thị tuổi quan sát và tỷ lệ phủ. Tránh look-ahead do bản sửa cuối kỳ.

## 5. Người dùng viết edge và strategy

Cung cấp editor nhận **code do người dùng tự viết**. Đừng giới hạn vào dropdown preset. V1 có thể dùng một ngôn ngữ biểu thức nhỏ có cú pháp gần Python, hỗ trợ biến nhiều dòng, số học, so sánh, điều kiện, toán tử thời gian và mặt cắt. Giao diện hiển thị danh sách field phù hợp dataset, tài liệu operator, units, min_periods, lỗi theo dòng/cột và preview kết quả từng biến trên asset/ngày đã chọn. Sửa và chạy được edge hoàn toàn mới, lưu tên, giả thuyết, ghi chú, version; load/fork/diff và rerun được.

```text
mom = close / lag(close, 4) - 1
risk = ts_std(returns(close, 1), 4)
score = rank(mom) - 0.25 * rank(risk)
```

Triển khai arithmetic, `returns`, `lag`, `delta`, `ts_mean`, `ts_std`, `ts_rank`, `rank`, `zscore`, `where`, `clip`; group_rank/group_demean nếu có group metadata. Định nghĩa rõ ties, hạng tăng/giảm, lookback và warm-up, missing values, zero denominator. Rank là xếp giữa các mã tại một timestamp; rolling theo từng mã. Ví dụ UI tự chọn lookback phù hợp với dataset tuần ngắn. Có ít nhất 3 ví dụ sửa được: momentum, mean reversion, tín hiệu điều chỉnh theo volatility. Hỗ trợ rule chiến lược sử dụng score, top-K, lịch rebalance, ngưỡng entry/exit hoặc max holding để người dùng thực sự có thể đổi cách giao dịch. Cho xem target và số lượng đã khớp.

Parse thành AST có allowlist, chỉ đọc dữ liệu as-of. Từ chối lookahead, tên trường nhãn, arbitrary imports, file/network/process access. Không chạy eval/exec code người dùng trong backend có secret. Không hứa arbitrary Python nếu chỉ triển khai DSL. Đặt giới hạn hợp lý và hiển thị lỗi hữu ích.

## 6. Engine và chỉ số quant

1. **Chẩn đoán tín hiệu.** Với quyết định ở close(t) và dữ liệu OHLC, nhãn mẫu cho h kỳ là open(t+1+h) / open(t+1) − 1, theo lịch và mark được công bố. Tính Spearman Rank IC riêng từng cross-section rồi mới tổng hợp. Hiện mean/median IC, số quan sát, IC theo thời gian, rolling IC, IC decay theo horizon, quantiles/buckets, chênh nhóm cao−thấp, rank autocorrelation hoặc turnover, coverage. Nếu không đủ tài sản, hạng hằng, ít kỳ hoặc thiếu exit hợp lệ, trả N/A kèm lý do và mẫu số. Báo độ bất định phù hợp, ví dụ block bootstrap theo phiên với seed. Mẫu ngắn hoặc nhãn chồng lấn phải hiển thị rõ.
2. **Danh mục lý tưởng và tài khoản có lệnh.** Tín hiệu, target, order, fill, mark và settlement có timestamp riêng. Hỗ trợ long-only/top-K cùng baseline equal-weight có cùng universe. Thêm long/short dollar-neutral như chẩn đoán lý tưởng, ghi gross/net exposure; chỉ mô phỏng short thực khi có quy tắc borrow/funding phù hợp. Chọn vốn, phí bps mỗi chiều, slippage, tần suất rebalance, giới hạn từng mã, đơn vị giao dịch/phân số và khả năng khớp. Quy ước fill không dùng tương lai để sizing. Ghi rõ giả định thanh khoản, cash, lot, giá stale, thiếu bar, treatment cổ tức và terminal positions. Với UCI dùng benchmark nội bộ có tên “equal-weight sample”, không gọi nó là chỉ số Dow Jones chính thức.
3. **Hiệu suất sau chi phí.** Hiện cumulative return, CAGR khi kỳ đo có ý nghĩa, volatility, Sharpe có risk-free và quy ước annualization, Sortino, maximum drawdown cùng ngày đỉnh/đáy/hồi phục, equity và underwater curve, turnover, exposure, concentration, trading costs, số fill và fill ratio. Nếu tính win rate, định nghĩa round trip, phân biệt giao dịch đang mở. So benchmark bằng active return, tracking error và information ratio khi có đủ mẫu. Hiện dấu, đơn vị, gross/net, horizon, confidence/sample size phù hợp cạnh chỉ số. Annualization theo dữ liệu (weekly, business daily, calendar daily) và ghi rõ lựa chọn. Trường không xác định hiện N/A có lý do.
4. **Độ bền của edge.** Chronological train/validation/test theo timestamp nhóm tất cả mã trong phiên. Walk-forward, xóa mẫu train có label chồng qua cutoff, fit dữ liệu/calibration trên train, đánh dấu holdout đã mở. Thử 1x/2x chi phí, trễ thêm một kỳ, universe con, baseline và null/shuffled control chạy với seed. Dùng grid nhỏ có giới hạn, ghi cả trial tốt và yếu. Khi so A/B chỉ thay biến người dùng chọn. Run lưu dataset_version, code/AST hash, engine version, cấu hình, benchmark và seed riêng; kết quả định lượng tái lập trong sai số đã nêu.
5. **Giải thích kết quả.** Từ một điểm trên chart phải lần được `source fields → biến trung gian → score → hạng → target → order → fill → chi phí → PnL/NAV`. Nếu không phát lệnh, chỉ rõ nguyên nhân. Các đại lượng diagnostic và PnL tài khoản phải có nhãn rõ ràng. Có thể đối chiếu ít nhất hai lần chạy bằng chênh lệch cấu hình, số liệu và ngày đầu tiên có kết quả khác.

## 7. Trực quan hóa dataset và edge là chức năng cốt lõi

- **Data Explorer.** Chọn dataset/version, mã, field, ngày, timeframe. Xem bảng phân trang, coverage, missingness, histogram/phân vị và dòng mẫu theo thời điểm. Hiển thị attribution và nguồn cho dữ liệu thật.
- **Linked charts.** Trên cùng trục thời gian đặt nến OHLC hoặc line tùy loại dữ liệu, volume nếu có, feature trung gian, raw score/rank, tín hiệu mua bán, target/actual exposure, marker decision và fill. Crosshair, zoom, brush và bộ lọc đồng bộ. Cho chọn trục/panel riêng hoặc normalize/rebase có ghi cách tính. Hover hiển thị giá trị, đơn vị, timestamp và độ trễ. Đổi edge hay tham số phải cập nhật chart theo đúng run/version.
- **Khám phá hai chiều.** Bấm vào ngày để mở cross-section tất cả mã và sắp theo score; bấm vào mã để xem distribution/chuỗi/histogram của chính mã đó. Scatter score tại t vs forward return tại horizon đã chọn, kèm số điểm, bins/quantile, drill-down tới asset/ngày. Lớp label tương lai chỉ bật ở chế độ đánh giá. Dùng heatmap IC theo thời gian/horizon, đường lợi suất tích lũy từng quantile và NAV–benchmark–drawdown.
- **Lồng ngữ cảnh.** Cho chọn thêm một series khác dataset, ví dụ FX reference rate và edge cổ phiếu, chọn raw/normalized/returns, xác định vùng thời gian giao nhau, hiển thị khoảng trống khi không có quan sát phù hợp. Không tạo tương quan kinh tế giả bằng imputation tùy ý.
- **Sử dụng được khi dataset lớn.** Downsample hoặc aggregate cho đồ thị theo viewport, riêng OHLC bảo toàn first open/max high/min low/last close và volume phù hợp. Toàn bộ metrics chạy trên dữ liệu gốc. Điểm được chọn dùng ID/time để truy giá trị chi tiết thực. Hỗ trợ loading/empty/error/retry, chart legend và table fallback. Không render biểu đồ bằng ảnh tĩnh.

## 8. Kịch bản nghiệm thu theo công việc của quant researcher

Viết unit tests cho số học, integration tests với Atlas trong namespace test riêng và browser E2E bằng Playwright hoặc tương đương. Dùng dữ liệu tổng hợp để chứng minh đúng số, sau đó dùng dữ liệu thị trường thật để chứng minh toàn bộ sản phẩm chạy. Các test UI phải đi qua controls của đúng file HTML bàn giao. Các API mock nếu có chỉ dùng cho unit test. Ghi ma trận pass/fail trong repo hoặc CI, cùng commit, deployment và thời điểm test. Không lưu lại raw market payload trong bằng chứng.

| Kiểm thử | Thao tác như một researcher | Bằng chứng tối thiểu |
|---|---|---|
| 01. Catalog | Mở production, chọn UCI và ECB, xem schema, nguồn, ngày đầu/cuối, số mã, coverage và chart | Response lấy từ Atlas; số quan sát ở UI khớp truy vấn độc lập. Nhãn Real/Synthetic đúng. Lần nạp thứ hai cùng nội dung giữ nguyên count và checksum |
| 02. Tạo edge thật | Gõ công thức mới trong editor, thêm một biến trung gian, sửa hệ số, validate, save, fork, reload rồi mở lại | UI giữ đúng code/version, preview theo asset/time khớp phép tính độc lập. Lỗi field/độ dài window trỏ đúng vị trí |
| 03. Điều tra dữ liệu so với điểm | Mở một mã và zoom vào một khoảng; hover một bar, chọn một timestamp, bấm hàng trong bảng rank rồi quay lại chart | Giá/feature/score ở cùng as-of, scatter/heatmap/bảng khớp asset, date, horizon; marker lệnh khớp trỏ tới đúng fill. Đổi timeframe/universe thực sự đổi kết quả |
| 04. Chống nhìn trước | Nhập field tương lai của UCI, thử lag âm. Thêm hoặc sửa observations chỉ ở sau cutoff trong namespace kiểm thử | Editor từ chối field/offset, tín hiệu, lệnh và NAV tính đến cutoff bất biến. Thay dữ liệu tương lai có thể đổi label tương lai trong evaluator |
| 05. Đối chứng số học | Tạo bằng code trong RAM fixture 4 mã có thứ hạng dự báo [4,3,2,1] và return [2%,−1%,1%,−2%] | Spearman = 0,8. Weights [0,375; 0,125; −0,125; −0,375] cho gross +1,25%. Tie và constant input đúng policy. Ngày thiếu dữ liệu không tự sinh fill |
| 06. Backtest tài khoản | Tạo run trên UCI với lookback ngắn tính bằng tuần, next-week open, phí và benchmark; xem ledger rồi đổi chi phí | Có đủ score, target, lệnh, fill, NAV và drawdown; so bằng một phép tính tham chiếu độc lập. Fixture mua/bán 100 đơn vị cùng mức giá 100, phí 10 bps mỗi chiều, không ma sát khác → phí 20, PnL −20 |
| 07. Robustness/OOS | Chạy walk-forward trên panel đủ dài, mở kết quả từng fold, thử đổi phí, độ trễ, universe, so với benchmark | Folds theo thời gian; mọi label dùng khi fit đã kết thúc; được xem cả trial kém. Fee 2x và lag +1 thực sự thay đổi giả định, so cùng baseline. Không dùng yêu cầu “phải sinh lãi” làm tiêu chí pass |
| 08. Nghiên cứu lại | Lưu run A, fork edge thành B, so sánh A/B; rerun A trên snapshot cũ sau khi catalog có version mới | Kết quả A tái lập, B nhận đúng edge version, có diff và có thể truy điểm khác đầu tiên. Job có ID và status thật |
| 09. Vận hành | Đóng tab ngay sau khi job được nhận, mở lại bằng session cũ; thử lỗi provider, retry và cancel một job đang chạy | Job/snapshot hợp lệ phục hồi được, tác vụ hủy không lộ kết quả dang dở như run hoàn tất, không trùng ledger, không render số giả khi lỗi |
| 10. Quyền và dữ liệu local | Mở hai workspace, thử dùng chức năng bình thường ở từng workspace; rà public repo, build HTML và storage của trình duyệt sau khi nghiên cứu | Người dùng khác chỉ thấy nội dung công khai. Không có credential trong HTML/source/history và không có dataset persist trong workspace/browser storage. Xác minh no-store cho response dữ liệu và repo không có data blobs |
| 11. HTML bàn giao | Tải file, mở bằng Chromium để xem; mở cùng artifact ở production, sửa một edge, bấm Run và mở report. Kiểm tra ở viewport desktop và màn nhỏ | Có bố cục, controls và trạng thái thực; local preview truy cập được dữ liệu công khai trên browser hỗ trợ; production hoàn thành mọi bước. HTML tải về có SHA-256 bằng HTML production |
| 12. Xác minh phát hành | Đọc lại repo ở chế độ public và gọi production bằng browser context mới, so revision đang chạy với commit phát hành | Repo tên đúng `q_plat`, visibility public, alias là production, commit triển khai đúng, Mongo readback thành công và smoke test qua Vercel pass |

Trong repo có hướng dẫn ngắn để **Codex ở prompt sau** xác định CSS tokens, layout và chart renderers cần sửa, chạy lại các E2E liên quan rồi deploy tiếp lên **chính URL production này**. Có thể thay đổi bố cục mà không tái nhập dữ liệu, không làm mất edge/run và không buộc người dùng tự sửa endpoint.

## 9. Điều kiện đóng Goal và định dạng bàn giao

Làm một lát cắt end-to-end trước: UCI → Atlas → nhập edge 4 kỳ → bảng hạng → chart giá/score → tài khoản → kết quả trên web. Sau đó hoàn tất các tính năng và test còn lại. Sau mỗi thất bại, chẩn đoán, sửa và chạy lại kiểm thử phù hợp. Khi nghiệm thu, kiểm tra cả nguồn dữ liệu, mã nguồn ở HEAD public, backend đang phục vụ và file HTML cuối. Nếu thiếu một đầu ra bắt buộc, ghi blocker cụ thể, phần đã hoàn tất và quyền/tác vụ thực sự cần; không đánh dấu Goal hoàn thành. Nếu một nguồn tùy chọn thiếu, ghi giới hạn ở Data Catalog và vẫn hoàn tất toàn bộ yêu cầu bắt buộc bằng những nguồn đã quy định.

Khi đạt, chỉ bàn giao **ba mục** bằng **link thực tế đã mở kiểm tra**:

1. `index.html` — tệp tải được, ưu tiên đính kèm hoặc link download trực tiếp đúng file production.
2. `Vercel production` — URL ổn định của ứng dụng. Người dùng mở tại đây để nhập edge, chạy backtest và thao tác mọi biểu đồ.
3. `GitHub · q_plat` — URL repo public thuộc đúng owner.

Đặt báo cáo kiểm thử, hash artifact và hướng dẫn duy trì trong README/CI của repo để không phát sinh đầu ra thứ tư. Chỉ hiển thị link, thông tin dùng ứng dụng và kết quả kiểm chứng thông thường. Tuyệt đối không đưa MongoDB URI, token hoặc mật khẩu vào tin nhắn bàn giao.

### Tài liệu kỹ thuật gốc để tra cứu khi triển khai

- Codex Goals: https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex
- MongoDB Atlas connection: https://www.mongodb.com/docs/atlas/connect-to-database-deployment/ · https://www.mongodb.com/docs/atlas/cli/current/command/atlas-clusters-connectionstrings-describe/ · https://www.mongodb.com/docs/atlas/reference/free-shared-limitations/
- Vercel Git integration, secrets và giới hạn runtime: https://vercel.com/docs/git/vercel-for-github · https://vercel.com/docs/environment-variables · https://vercel.com/docs/functions/limitations · https://vercel.com/docs/cli/deploy
- GitHub CLI public repository: https://cli.github.com/manual/gh_repo_create
- WorldQuant Learn2Quant (workflow mô phỏng/rà edge): https://www.worldquant.com/learn2quant/
- QuantConnect time frontier: https://www.quantconnect.com/docs/v2/writing-algorithms/key-concepts/time-modeling/timeslices
- Alphalens IC và quantile statistics: https://quantopian.github.io/alphalens/alphalens.html
- Qlib experiment recorder: https://qlib.readthedocs.io/en/stable/component/recorder.html
