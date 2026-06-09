# Pact Network — Mô hình kinh doanh & Dòng tiền (VI)

> Soạn 2026-06-03 trên `feat/multi-network`. Giải thích 2 mô hình bảo hiểm, các bên tham gia,
> và dòng tiền — để hiểu vì sao `wrap` (gateway) và `facilitator` (x402) hoàn tiền khác nhau.
> Companion: `ARCHITECTURE.vi.md`, `TRUST-MODEL.vi.md`.

## Pact Network làm gì (một câu)

Là **tầng rủi ro on-chain cho thanh toán API của AI agent**: mỗi endpoint được bảo hiểm có một
**pool** (quỹ USDC); mỗi lần gọi, một **premium** nhỏ bị trừ từ ví USDC của agent; nếu call vi phạm
SLA (chậm, 5xx, lỗi mạng) thì agent được **hoàn tiền** tự động. Mọi quyết toán đều on-chain, chia phí
rõ ràng theo từng người nhận.

## Các bên tham gia

- **Agent** (AI agent / user): bên gọi API, giữ USDC.
- **Merchant / Provider**: API được bảo hiểm (Helius, Birdeye, Jupiter…).
- **Pool**: quỹ bảo hiểm theo từng endpoint — giữ USDC, trả tiền hoàn.
- **Treasury**: ví phí của mạng Pact.
- **Integrator**: bên đăng ký endpoint (affiliate), ăn một phần phí.
- **Program on-chain** (Solana Pinocchio v1 / EVM contracts): thực thi việc gom + chia + hoàn tiền (`settle_batch`).
- **Settler**: worker off-chain, gom các settlement event rồi đẩy `settle_batch` lên chain.

## Hai khái niệm tiền

- **`flat_premium`**: phí cố định trừ của agent mỗi lần gọi (giá bảo hiểm).
- **`imputed_cost`**: số tiền hoàn cho agent khi call vi phạm SLA (giá trị "quy đổi" của một call hỏng).

---

## Luồng A — Gateway / Market proxy (`wrap`) = bảo hiểm THAM SỐ (parametric)

```
                          premium (nhỏ, mỗi lần gọi)
   ┌─────────┐  gọi API   ┌──────────────┐  forward   ┌────────────┐
   │  AGENT  │ ─────────► │ market-proxy │ ─────────► │  PROVIDER  │
   │ (USDC)  │ ◄───────── │  (wrap)      │ ◄───────── │ (Helius..) │
   └────┬────┘  response  └──────┬───────┘  response  └────────────┘
        │                        │ phát "settlement event"
        │                        ▼
        │                  ┌───────────┐   settle_batch   ┌─────────────────┐
        │   hoàn tiền nếu  │  settler  │ ───────────────► │ program on-chain │
        │   breach (SLA)   └───────────┘                  └────────┬────────┘
        │                                                          │ chia premium:
        │                                              ┌───────────┼───────────┐
        │                                              ▼           ▼           ▼
        │                                          ┌──────┐   ┌────────┐  ┌──────────┐
        └──────────── refund = imputed_cost ◄──────│ POOL │   │TREASURY│  │INTEGRATOR│
                      (LUÔN trả đủ, cố định)        └──────┘   └────────┘  └──────────┘
```

- Mỗi call: trừ **premium** từ USDC của agent. Premium chia: phần lớn vào **Pool** (phần dư),
  một cắt cho **Treasury**, một cắt cho **Integrator**.
- Nếu breach SLA → **Pool hoàn `imputed_cost`** — số **cố định, định trước**, không phụ thuộc agent
  trả bao nhiêu. Đây là **bảo hiểm tham số**: "hỏng thì trả đúng X".
- Phân loại kết quả call diễn ra **server-side** trong proxy (proxy tự thấy response thật).

## Luồng B — x402 / Facilitator (`facilitator`) = bảo hiểm BỒI THƯỜNG (indemnity)

```
   ┌─────────┐   trả TRỰC TIẾP cho merchant (amountPaid, qua x402/MPP)   ┌────────────┐
   │  AGENT  │ ─────────────────────────────────────────────────────►   │  MERCHANT  │
   │ (USDC)  │                                                            │ (Provider) │
   └────┬────┘                                                            └────────────┘
        │   pact pay phân loại call (client-side) → POST verdict + receipt lên facilitator
        │   nếu breach → hoàn = min(amountPaid, imputed_cost)
        │              (bồi thường ĐÚNG cái agent đã mất, trần = imputed_cost)
        ▼
   ┌──────┐  (qua settler → settle_batch như Luồng A)
   │ POOL │
   └──────┘
```

- Agent **trả thẳng cho merchant** (`amountPaid`) qua x402.
- Khi breach → hoàn **`min(amountPaid, imputed_cost)`** = trả lại đúng số đã mất, có trần.
  Đây là **bảo hiểm bồi thường**: "mất bao nhiêu trả bấy nhiêu, không quá trần".

---

## Vì sao refund khác nhau (divergence ở PR #251)

```
Covered breach, cùng pool:
  amountPaid >= imputed_cost  →  wrap = imputed,  facilitator = imputed     (GIỐNG)
  amountPaid <  imputed_cost  →  wrap = imputed,  facilitator = amountPaid   (KHÁC — wrap trả NHIỀU hơn)
```

- **Gateway/`wrap`**: parametric, luôn trả `imputed_cost` (agent trả *premium* vào pool, không trả thẳng merchant).
- **x402/`facilitator`**: trả `min(amountPaid, imputed)` (agent trả thẳng merchant → chỉ bồi thường cái đã mất).

→ Đây nhiều khả năng **CÓ chủ ý** (2 mô hình bảo hiểm cho 2 luồng thanh toán khác nhau), không phải
copy-paste lỗi. Comment cũ "identical to wrap's defaultClassifier" là **sai** — đã sửa ở PR #251,
và một hàm `computeEconomics({outcome, pool, amountPaid?})` duy nhất giờ phục vụ cả hai
(wrap gọi không truyền `amountPaid`; facilitator gọi có truyền). **Câu hỏi product còn mở:** 2 mô hình
này có cố ý không, hay nên gộp về một? (đã flag cho Rick trên agent-tasks#3).
