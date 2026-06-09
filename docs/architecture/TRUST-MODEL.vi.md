# Pact Network — Mô hình tin cậy của Classifier (VI)

> Soạn 2026-06-03 trên `feat/multi-network`. Trả lời: việc phân loại kết quả call diễn ra Ở ĐÂU,
> ai có thể gian lận, và vì sao classifier ở server/proxy đáng tin hơn ở client.
> Companion: `BUSINESS-MODEL.vi.md`. Finding bảo mật liên quan: agent-tasks#10.

## Nguyên tắc cốt lõi

Phân loại quyết định **tiền** (thu premium / hoàn refund). Vì vậy **nơi nó chạy** quan trọng:
- Chạy **server-side** (proxy/oracle quan sát kết quả thật) → client KHÔNG sửa được → **đáng tin**.
- Chạy **client-side** (client tự chấm rồi khai báo) → client CÓ THỂ nói dối → **không đáng tin cho tiền**.

## Bảng so sánh nơi phân loại

```
                         Phân loại Ở ĐÂU?          Client gian lận được?     Dính tiền?
gateway (wrap/market-proxy)   SERVER-SIDE            KHÔNG — proxy tự thấy      CÓ
                              (proxy quan sát         response thật của upstream
                               response thật)
facilitator (x402)            CLIENT khai báo!       CÓ — verdict do CLI        CÓ  ← ĐIỂM YẾU
                              verdict gửi lên          tự chấm rồi gửi lên
monitor (scorecard)           CLIENT-SIDE            CÓ — nhưng chỉ điểm số      KHÔNG
                                                       reliability, không tiền
backend/routes/monitor.ts     SERVER-SIDE            KHÔNG — nhưng chỉ            KHÔNG
                                                       playground/scorecard
```

## Đường tin cậy: gateway (đáng tin)

`wrap` chạy bên trong `market-proxy` (server-side). Proxy nằm giữa agent và upstream, **tự quan sát
Response thật** rồi phân loại. Agent điều khiển request nhưng KHÔNG điều khiển được cái proxy thấy là
response → **không thể giả mạo kết quả**. Đây là mô hình chuẩn cho money path.

## Đường yếu: facilitator (x402) — tin verdict do client khai

Đọc `packages/facilitator/src/routes/coverage.ts`:
- Agent (`pact pay`) chạy `pay-classifier.ts` **ở máy client**, tự ra `verdict` (vd `server_error`),
  rồi POST lên facilitator.
- Facilitator chỉ kiểm: (1) chữ ký ed25519 (xác thực agent, chống giả mạo agent khác);
  (2) ở "verified mode" thì kiểm on-chain rằng **khoản thanh toán** có thật.
- **NHƯNG nó KHÔNG tự kiểm `verdict` đúng/sai** — chỉ check `isKnownVerdict` (đúng định dạng enum),
  rồi `verdictToOutcome` → tính refund.

→ Agent xấu có thể khai `verdict: "server_error"` (breach được bồi thường) **dù call thật sự thành công**,
để rút refund từ pool. Đây là gian lận kiểu indemnity — cùng nhóm với finding SOL-01 (tin dữ liệu do
caller cung cấp trên money path).

### Các rào chắn ĐÃ có (nên thiệt hại bị giới hạn, không phải vô hạn)

- Chữ ký ed25519 → gian lận buộc gắn với chính key của agent (không ẩn danh).
- "Verified mode": xác nhận **đã trả tiền** on-chain (≥ `amountBaseUnits` tới `payee`) — nhưng
  *đã trả tiền* ≠ *call đã fail*; verdict vẫn được tin.
- On-chain: **trần phơi nhiễm theo giờ** mỗi pool + **trần imputed-cost ~$1/call**; refund cap = `min(amountPaid, imputed)`.
- "Unverified / degrade mode" (`pay 0.16.0` không lộ `payee`+`paymentSignature`) → **bỏ luôn kiểm
  thanh toán**, chỉ còn các trần on-chain bảo vệ.

## Khuyến nghị (đã flag cho Rick — agent-tasks#10, chưa hành động)

1. **Oracle / xác thực outcome server-side** — facilitator (hoặc oracle) tự quan sát/xác minh kết quả
   call thay vì tin verdict client. Mạnh nhất, khớp mô hình gateway. Khó với x402 (agent gọi merchant trực tiếp).
2. **Bắt buộc verified mode** + yêu cầu receipt-fail có chữ ký merchant trước khi đủ điều kiện hoàn;
   bỏ đường unverified/degrade cho payout.
3. **Siết trần + rate-limit theo agent + phát hiện bất thường** trên phân phối verdict (rẻ, một phần).
4. **Chấp nhận & giám sát** — coi là rủi ro có giới hạn đã biết cho x402 MVP; theo dõi loss-ratio.

## Tóm tắt

Classifier ở **gateway/proxy (server-side) đáng tin nhất** vì proxy tự quan sát response thật.
`facilitator` (x402) tin verdict do client tự khai → lỗ hổng kiến trúc thật, bị giới hạn bởi các trần
on-chain. `monitor` cũng client-side nhưng chỉ chấm điểm reliability, không dính tiền nên chấp nhận được.
