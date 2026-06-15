# Pact Network — Phân tích từng package (VI)

> Soạn 2026-06-03 trên nhánh `feat/multi-network @ 2b5cb0c`, sau khi đã gỡ stack V2 off-chain.
> Mỗi package trả lời 5 câu hỏi: **(1) Là gì · (2) Ý nghĩa với project · (3) Nếu không có thì sao ·
> (4) Có overlap không · (5) Phụ thuộc package nào.** Quan hệ phụ thuộc lấy trực tiếp từ
> `package.json` (`dependencies` + `devDependencies`).

## Trạng thái hiện tại (2026-06-03 — nhất quán giữa cả ba doc)

Bản breakdown này, `ARCHITECTURE.{en,vi}.md` và `DIVERGENCE-AUDIT.{en,vi}.md` đều được cập nhật ngày
**2026-06-03** theo commit `2b5cb0c` (gỡ V2 off-chain). Cả ba thống nhất:

- **5 package V2 off-chain đã bị gỡ hoàn toàn:** `wrap-v2`, `settler-v2`, `indexer-v2`, `db-v2`,
  `protocol-v2-client`. Thư mục của chúng đã bị xoá sạch trong commit `2b5cb0c` (không còn `dist/` hay
  `node_modules` sót lại) ⇒ **không cần làm gì thêm** — việc dọn dẹp đã hoàn tất.
- Số package "sống" còn **~17 TS + 2 on-chain** (không phải 24 như doc cũ ghi); các thư mục V2 đã biến mất.
- **Debt D2 ("2 V2 Solana client song song") đã được giải quyết một nửa:** `protocol-v2-client` đã mất,
  chỉ còn `insurance`. Không còn "song song" — chỉ còn 1 client V2.
- **Debt D1 ("classifier 5 bản copy") bị nói quá:** thực tế xem `ANALYSIS.md` — `wrap-v2` đã xoá,
  `market-proxy` vốn *import* `wrap` (không phải bản copy), bản copy thật duy nhất nằm ở
  `backend/src/routes/monitor.ts:24`.

---

## NHÓM A — Rails core (lõi dùng chung, tái sử dụng được)

### `wrap` — `@pact-network/wrap`
- **Là gì:** Thư viện "bọc" một lời gọi `fetch()` để biến nó thành lời gọi *có bảo hiểm*: kiểm tra số dư
  agent, gắn header `X-Pact-*`, tính premium, và **phân loại kết quả (classifier)** → ok / latency_breach /
  server_error / client_error / network_error, kèm số tiền premium + refund.
- **Ý nghĩa:** Đây là **trái tim logic nghiệp vụ off-chain**. Mọi interface (Market proxy, facilitator x402)
  đều chạy qua nó. `classifier.ts` ở đây là **source-of-truth chuẩn** cho luật SLA.
- **Nếu không có:** Sập toàn bộ tầng bảo hiểm — proxy/facilitator không còn biết khi nào tính phí / hoàn tiền.
  Không thay thế được; phải viết lại từ đầu.
- **Overlap:** Logic classifier bị *lặp lại* (không phải import) ở `monitor` và `backend/routes/monitor.ts`;
  logic premium/refund bị lặp ở `facilitator/lib/coverage.ts` (`computeCoverage`). → đối tượng chính của P1.
- **Phụ thuộc:** Không (leaf). Đây là điểm tốt — giữ nó dependency-light.

### `shared` — `@pact-network/shared`
- **Là gì:** Tầng trừu tượng đa-VM (ports-and-adapters): định nghĩa `ChainAdapter` + `SolanaAdapter` +
  `EvmAdapter`, cùng các hằng seed PDA và type dùng chung.
- **Ý nghĩa:** **Là "seam" cho phép cùng một code chạy trên Solana và EVM (Arc, Base).** Thêm chain mới =
  viết thêm 1 adapter; settler/indexer/proxy không cần đổi. Đây là điểm sáng kiến trúc của nhánh này.
- **Nếu không có:** Mất tính đa-network — settler/indexer/proxy sẽ phải hardcode từng chain, code phình to và
  rẽ nhánh khắp nơi.
- **Overlap:** Không. Vai trò độc nhất.
- **Phụ thuộc:** `protocol-v1-client`, `protocol-evm-v1-client`, `wrap`.

### `protocol-v1-client` — `@q3labs/pact-protocol-v1-client`
- **Là gì:** TS client cho chương trình Solana v1 (Pinocchio): PDA helper, instruction builder, account
  decoder, error map.
- **Ý nghĩa:** Cầu nối duy nhất giữa code TS và program Solana v1 on-chain. Được publish (scope `@q3labs`).
- **Nếu không có:** Không gọi/đọc được program Solana — settler không settle được, indexer không decode được,
  dashboard/SDK/CLI mất đường vào chain.
- **Overlap:** Không (nó cho v1; `insurance`/`protocol-v2-client` là cho v2).
- **Phụ thuộc:** Không (leaf).

### `protocol-evm-v1-client` — `@pact-network/protocol-evm-v1-client`
- **Là gì:** TS client cho bộ 3 hợp đồng Solidity EVM v1 (`PactPool`, `PactSettler`, `PactRegistry`): ABI,
  địa chỉ, encode, đọc state, error.
- **Ý nghĩa:** Đối ứng EVM của `protocol-v1-client`; là thứ làm cho multi-network (Arc/Base) thành hiện thực
  ở tầng server.
- **Nếu không có:** Mất hoàn toàn nhánh EVM của fleet server — chỉ còn Solana.
- **Overlap:** Không. (SDK/CLI có đường EVM *riêng* qua `viem` — đó là chủ ý layering, không phải trùng lặp.)
- **Phụ thuộc:** Không (leaf).

---

## NHÓM B — Dịch vụ server (backbone, tái sử dụng tốt)

### `settler` — `@pact-network/settler`
- **Là gì:** Service NestJS tiêu thụ hàng đợi Pub/Sub và đệ giao dịch `settle_batch` lên chain (gom premium
  vào pool/treasury/integrator, hoàn tiền khi breach).
- **Ý nghĩa:** Là "tay" ghi tiền on-chain. Không có nó thì các sự kiện settlement chỉ nằm trong hàng đợi,
  không bao giờ lên chain.
- **Nếu không có:** Premium/refund không bao giờ được quyết toán → sản phẩm mất nghĩa.
- **Overlap:** Không (settler-v2 đã xoá). Trước đây song song với settler-v2, nay là duy nhất.
- **Phụ thuộc:** `shared`, `wrap`, `protocol-v1-client`, `protocol-evm-v1-client`. (Tái sử dụng đúng backbone.)

### `indexer` — `@pact-network/indexer`
- **Là gì:** Service NestJS nhận sự kiện settlement (`POST /events`), ghi vào Postgres, phục vụ read API,
  giao refund, và xử lý reorg.
- **Ý nghĩa:** Là "trí nhớ" + API đọc của hệ thống — nguồn dữ liệu cho dashboard và đối soát.
- **Nếu không có:** Không có lịch sử/thống kê/refund-delivery; dashboard trắng; không audit được.
- **Overlap:** Không (indexer-v2 đã xoá).
- **Phụ thuộc:** `shared`, `db`, `protocol-v1-client`, `protocol-evm-v1-client`.

### `db` — `@pact-network/db`
- **Là gì:** Prisma schema cho indexer (PoolState, Settlement, SettlementRecipientShare, RecipientEarnings).
- **Ý nghĩa:** Hợp đồng dữ liệu cho tầng persistence; chỉ `indexer` dùng.
- **Nếu không có:** indexer không có schema để ghi/đọc.
- **Overlap:** Trước có `db-v2` (đã xoá) từng share chung output Prisma gây race build — nay chỉ còn `db`.
- **Phụ thuộc:** Không (leaf).

---

## NHÓM C — Pact Market (1 interface trên rails)

### `market-proxy` — `@pact-network/market-proxy`
- **Là gì:** Proxy Hono (Cloud Run) bọc các provider tuyển chọn (Helius, Birdeye, Jupiter, Elfa, fal.ai);
  tiêu thụ `wrap` để bảo hiểm từng lời gọi.
- **Ý nghĩa:** Là sản phẩm "Pact Market" — bề mặt thương mại hoá rails. `lib/classifiers.ts` là **ví dụ mẫu**
  về cách *import* classifier của `wrap` (plugin Helius) — đúng pattern mà P1 muốn nhân rộng.
- **Nếu không có:** Mất sản phẩm Market (nhưng rails vẫn sống — người khác vẫn build được trên rails).
- **Overlap:** **Không** — nó import `wrap`, không tự copy. (Doc cũ xếp nhầm nó là "1 trong 5 bản copy".)
- **Phụ thuộc:** `shared`, `wrap`, `protocol-evm-v1-client`. Phụ thuộc *runtime gián tiếp* vào key do `backend` cấp.

### `market-dashboard` — `@pact-network/market-dashboard`
- **Là gì:** Dashboard Next.js 15 (App Router, Tailwind 4, wallet-adapter) cho Pact Market.
- **Ý nghĩa:** Bề mặt UI cho người dùng Market xem pool/agent/settlement.
- **Nếu không có:** Mất UI Market; dữ liệu vẫn truy được qua indexer API.
- **Overlap:** Khái niệm trùng `scorecard` (đều là frontend) nhưng khác sản phẩm/đời (Market vs scorecard legacy).
- **Phụ thuộc:** `protocol-v1-client` (đọc state on-chain phía client).

---

## NHÓM D — SDK / CLI / x402 (các interface client)

### `sdk` — `@q3labs/pact-sdk`
- **Là gì:** SDK phía agent (createPact, golden-fetch, ký Solana + EVM qua `viem`).
- **Ý nghĩa:** Cách "chuẩn" để dev tích hợp agent vào Pact mà không qua Market proxy. **Đây là package trung
  tâm của quyết định #1 của Rick** (one SDK + merchant subpath vs hai package).
- **Nếu không có:** Dev phải tự dựng lời gọi có bảo hiểm — rào cản tích hợp lớn.
- **Overlap:** Một phần khái niệm với `monitor` (đều wrap fetch phía client) và với surface merchant ở PR #223
  (chưa merge). Cần Rick chốt hình dạng để tránh drift.
- **Phụ thuộc:** `protocol-v1-client` (+ `viem` cho EVM). **Không** dùng `shared` — đúng layering cho client.

### `cli` — `@q3labs/pact-cli` (binary `pact`)
- **Là gì:** CLI đa-network (Solana + Arc + Base): `pay` (bọc x402/MPP), thao tác operator. Bundle bằng
  `bun build` thành 1 file `dist/pact.js`.
- **Ý nghĩa:** Bề mặt dòng lệnh cho operator/agent. **Đối tượng quyết định #2 của Rick** (một `pact` hay tách
  binary x402 riêng).
- **Nếu không có:** Mất đường thao tác bằng lệnh; phải dùng SDK/script tay.
- **Overlap:** `lib/pay-classifier.ts` (parser stdout/stderr) là *miền khác* classifier — không phải bản copy
  của `wrap`. `lib/facilitator.ts` + `lib/envelope.ts` lặp lại *contract* của package `facilitator` (debt D4 nhẹ).
- **Phụ thuộc:** `protocol-v1-client`, `monitor` (khai trong `devDependencies` vì được bundle — đúng, không phải lỗi).

### `facilitator` — `@pact-network/facilitator`
- **Là gì:** Facilitator kiểu x402: nhận "verdict" từ CLI/agent, map về `Outcome` chuẩn của `wrap`, tính
  premium/refund, sinh coverageId tất định để chống trùng.
- **Ý nghĩa:** Interface x402 trên rails — cho luồng `pay.sh`/x402 cắm vào hệ settlement.
- **Nếu không có:** Mất đường x402; agent dùng x402/MPP không được bảo hiểm.
- **Overlap:** `coverage.ts` `computeCoverage` **lặp lại logic premium/refund của `wrap`** (doc tự ghi "identical
  to wrap's defaultClassifier"). → ứng viên P2.5 mà audit cũ bỏ sót.
- **Phụ thuộc:** `wrap`.

---

## NHÓM E — Pre-Step-A / legacy (vẫn chạy, cần khoanh vùng)

### `monitor` — `@q3labs/pact-monitor`
- **Là gì:** SDK độc lập bọc `fetch()` để *đo độ tin cậy* (success/timeout/schema_mismatch/server/client_error)
  + validate schema. Có classifier riêng.
- **Ý nghĩa:** Phục vụ scorecard công khai / demo SDK đời đầu. Được CLI import.
- **Nếu không có:** Mất nguồn phân loại reliability cho scorecard; CLI mất 1 dependency.
- **Overlap:** Classifier của nó **trùng khái niệm** với `wrap` nhưng khác từ vựng/đầu vào (statusCode thô,
  không có kinh tế). Bản `classify` này còn **bị copy nguyên xi** vào `backend/routes/monitor.ts:24` → đây mới
  là bản copy thật cần gỡ.
- **Phụ thuộc:** Không (leaf). 0 dep nội bộ — đảo độc lập (debt D3, phần lớn là chủ ý).

### `insurance` — `@q3labs/pact-insurance`
- **Là gì:** SDK TS cho program bảo hiểm V2 (legacy): `client.ts` + `kit-client.ts` + `legacy-anchor-client.ts`
  + `generated/`.
- **Ý nghĩa:** Client V2 *duy nhất còn lại* sau khi `protocol-v2-client` bị xoá. `backend` (phần claims/V2) phụ thuộc nó.
- **Nếu không có:** Phần V2/claims trong `backend` sập; nhưng Market control-plane (phần release-critical) **không** ảnh hưởng.
- **Overlap:** Trước song song với `protocol-v2-client` (debt D2) — **nay không còn song song** (kia đã xoá).
  Giữ `legacy-anchor-client.ts` chỉ làm đường rollback.
- **Phụ thuộc:** Không (leaf).

### `backend` — `@pact-network/backend`
- **Là gì:** Control-plane Market chạy thật (Fastify): cổng private-beta, cấp API key tự phục vụ, faucet,
  partners/CRM. **Kèm** routes scorecard cũ (providers/records/analytics) + phần claims V2.
- **Ý nghĩa:** **KHÔNG phải legacy chết** — `market-proxy` xác thực key do nó cấp ⇒ release-critical. Phần legacy
  chỉ là scorecard + claims V2, đã khoanh vùng gọn (`routes/pools.ts` + `crank/*` + `services/claim-settlement.ts`).
- **Nếu không có:** Không cấp/khoá được key → Market proxy không cho ai vào; faucet/onboarding hỏng.
- **Overlap:** `routes/monitor.ts:24` chứa **bản copy classifier của `monitor`** (gỡ được an toàn).
  Phần V2/claims dùng `insurance` (tách được sang sau).
- **Phụ thuộc:** `insurance` (chỉ cho nhánh V2/claims, không phải control-plane).

### `scorecard` — `@pact-network/scorecard`
- **Là gì:** Frontend Vite+React của scorecard công khai đời đầu; gọi `backend` qua HTTP.
- **Ý nghĩa:** Bề mặt xếp hạng độ tin cậy provider (legacy). Tách rời, gọi REST.
- **Nếu không có:** Mất trang scorecard công khai; không ảnh hưởng rails/Market.
- **Overlap:** Trùng vai trò "frontend" với `market-dashboard` nhưng khác sản phẩm/đời. Ứng viên carve-out legacy.
- **Phụ thuộc:** Không (leaf; chỉ gọi backend qua HTTP, không qua workspace).

### `dummy-upstream` — `@pact-network/dummy-upstream`
- **Là gì:** Upstream giả, không cần key, phục vụ smoke test.
- **Ý nghĩa:** Công cụ test; cho phép chạy luồng proxy end-to-end mà không tốn quota provider thật.
- **Nếu không có:** Smoke test phải gọi provider thật (tốn key/tiền, dễ flaky).
- **Overlap:** Không.
- **Phụ thuộc:** Không (leaf).

---

## NHÓM F — On-chain (không qua package.json)

### `program` (Rust)
- **Là gì:** Chứa program Solana Pinocchio **v1** (`pact-network-v1-pinocchio`, đang chạy), Pinocchio **v2**
  (tương lai), và crate Anchor `pact-insurance` **LEGACY** (chỉ rollback, không sửa).
- **Ý nghĩa:** Là luật on-chain Solana — nơi tiền thực sự được gom/chia/hoàn.
- **Nếu không có:** Không có settlement Solana.
- **Overlap:** Crate Anchor legacy trùng vai trò với Pinocchio v1 nhưng đã đóng băng (chỉ dự phòng).
- **Phụ thuộc:** `protocol-v1-client` ánh xạ tới nó (chiều ngược: client → program đã deploy).

### `program-evm` (Solidity)
- **Là gì:** Bộ 3 hợp đồng EVM v1 (`PactPool`, `PactSettler`, `PactRegistry`) — Foundry project.
- **Ý nghĩa:** Luật on-chain EVM (Arc/Base) — đối ứng của program Solana.
- **Nếu không có:** Mất nhánh EVM hoàn toàn.
- **Overlap:** Không (đối ứng, không trùng).
- **Phụ thuộc:** `protocol-evm-v1-client` ánh xạ tới nó.

---

## NHÓM Z — Đã gỡ (ghi chú lịch sử)

`wrap-v2` · `settler-v2` · `indexer-v2` · `db-v2` · `protocol-v2-client` — 5 thư mục V2 này đã bị xoá hoàn toàn
trong commit `2b5cb0c`. Không còn thư mục sót lại; không có gì để dọn.

---

## Tổng hợp overlap & ưu tiên dọn (rút ra từ trên)

| Ưu tiên | Việc | Phạm vi thật (đã xác minh) |
|---|---|---|
| #0 ✅ XONG | Xoá 5 thư mục zombie V2 | Đã hoàn tất ở `2b5cb0c` — 5 thư mục V2 đã bị gỡ hoàn toàn; không còn thư mục sót lại. |
| P1 | Gom classifier | Bản copy thật **duy nhất** = `backend/routes/monitor.ts:24` → import `monitor`. + viết **parity test** (chưa từng có). `market-proxy` đã import sẵn `wrap`. `cli` để yên (miền khác). |
| P2 | Gộp client V2 | **Đã xong một nửa** — `protocol-v2-client` mất; chỉ còn `insurance`. Việc còn lại: dọn alias/ghi chú, không còn "song song". |
| P2.5 | Gom kinh tế premium/refund | `facilitator/coverage.ts` `computeCoverage` lặp `wrap` — audit cũ bỏ sót. Cân nhắc issue riêng (đụng đường tiền). |
| P3 | Khoanh legacy | Tách scorecard routes + V2/claims khỏi `backend`; chia sẻ contract `facilitator` cho `cli` (D4). Pass sau. |

> Chi tiết classifier: xem `ANALYSIS.md` cùng thư mục issue #3. `ARCHITECTURE.*` và `DIVERGENCE-AUDIT.*` đã được
> cập nhật ngày 2026-06-03 (`2b5cb0c`) cho khớp — không còn liệt kê các package V2 đã xoá như đang sống và đã
> phản ánh các kết luận D1/D2 đã sửa.
