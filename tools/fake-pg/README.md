# 가짜 PG 모의 서버 (`tools/fake-pg/`)

로컬 개발 및 통합 테스트 전용 가짜 결제 대행사(Mock PG) 서버입니다. 외부 PG사와의 실제 통신 없이도 토스페이먼츠의 전체 결제 및 환불 웹훅 계약을 로컬 단일 프로세스에서 완벽히 시뮬레이션합니다.
의존성 없음 — Node.js 내장 `http` 모듈만 사용합니다.

```bash
npm run fake-pg
# 또는
node tools/fake-pg/server.mjs --port 4010
```

기동 시 stdout에 `LISTENING:{port}` 한 줄을 출력한다(vitest 하네스가 파싱).

## 환경변수(테스트 고정값)

| 변수 | 값 |
|---|---|
| `TOSS_SECRET_KEY` | `test_sk_fake0000000000000000` |
| `NEXT_PUBLIC_TOSS_CLIENT_KEY` | `test_ck_fake0000000000000000` |
| `TOSS_API_BASE_URL` | `http://127.0.0.1:4010/toss` |
| `NEXT_PUBLIC_TOSS_SDK_URL` | `http://127.0.0.1:4010/toss/v2/standard` |
| `PAYAPP_USERID` | `fake-merchant` |
| `PAYAPP_LINKKEY` | `fake-linkkey-0000` |
| `PAYAPP_LINKVAL` | `fake-linkval-0000` |
| `PAYAPP_SHOPNAME` | `fake-shop` (결제 화면에 보이는 상점 이름 — 실서버는 필수, 2026-10-02) |
| `PAYAPP_API_URL` | `http://127.0.0.1:4010/payapp` |
| `FAKE_PG_TOSS_WEBHOOK_URL` | 결제에 `webhookUrl`이 없을 때 토스 웹훅을 보낼 주소(기본 없음, `npm run dev:fake`가 설정) |

## 토스 엔드포인트

| 경로 | 메서드 | 역할 |
|---|---|---|
| `/toss/v2/standard` | GET | 가짜 SDK (`TossPayments` → `/toss/checkout`) |
| `/toss/checkout` | GET | 성공/실패 버튼 HTML |
| `/toss/checkout/confirm` | POST | 성공 → `paymentKey` 발급 후 `successUrl` 302 |
| `/toss/checkout/fail` | POST | 실패/취소 → `failUrl` 302 |
| `/toss/v1/payments/confirm` | POST | Basic 인증 + 금액 대조. 중복 시 `ALREADY_PROCESSED_PAYMENT` |
| `/toss/v1/payments/:paymentKey` | GET | 결제 + `cancels[]` |
| `/toss/v1/payments/:paymentKey/cancel` | POST | 취소(+ `Idempotency-Key` 재생·`refundableAmount` 검증·잔액/이미취소 검사) + 웹훅 |
| `/__control/toss/webhook` | POST | 웹훅 재전송 트리거 |
| `/__control/toss/cancel-behavior` | POST | 일회성 취소 오류 주입(`reject_403`·`provider_error_400`·`server_500`·`timeout_before_apply`·`timeout_after_apply`·`off`) |

매직 금액: `amount=1` confirm 확정 거절(403 `REJECT_CARD_PAYMENT`), `amount=2` confirm 성공·웹훅 전송 스킵, `amount=3` confirm 2xx지만 `WAITING_FOR_DEPOSIT`, `amount=4` confirm 500(재조회는 `READY` — 결과 불명), `amount=5` confirm 500 + 결제 조회도 500(결과 불명).

## 페이앱 엔드포인트

| 경로 | 메서드 | 역할 |
|---|---|---|
| `/payapp/oapi/apiLoad.html` | POST | `cmd=payrequest`(**`shopname` 없거나 `smsuse`가 `n`이 아니면 `state=0`으로 거절**, 2026-10-02 — 실서버 필수 항목·문자 발송 방지) / `cmd=paycancel`(`linkval` 검증·이미취소/초과 시 `state=0`, 오류 문구는 **임의 문자열**) |
| `/payapp/pay/:mul_no` | GET | 성공/실패 버튼 HTML |
| `/payapp/pay/:mul_no/confirm` | POST | feedbackurl에 `pay_state=4` 통보 후 returnurl 302 |
| `/__control/payapp/refund` | POST | 관리자 환불 통보(e2e·제어면) |
| `/__control/payapp/cancel-behavior` | POST | 일회성 취소 오류 주입(`state0`·`http500`·`timeout_before_apply`·`timeout_after_apply`·`off`) |

매직 금액: `price=1` → `state=0` (결제창 생성 실패).  
feedback 응답이 `SUCCESS`가 아니면 2초 뒤 1회 재전송(`checkretry=y`일 때).
