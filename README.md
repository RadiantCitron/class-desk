# class-desk

1인 강사용 수강·결제·수강권 관리 웹 서비스의 소스코드입니다. 개설강의 신청 → 토스페이먼츠 결제 → 승인 → 디스코드 역할 부여(수강권)까지의 흐름과 환불·폐강·종료 처리를 담고 있습니다.

- 직접 운영하려고 만든 시스템이면서, 백엔드 기술(트랜잭션, RLS/RPC, 멱등 결제, 아웃박스, 원장 설계)을 직접 적용해 익히기 위한 프로젝트입니다.
- **포트폴리오용 소스코드**입니다. 그대로 배포해 쓰는 완성품이 아니며, 배포 스크립트는 포함하지 않았습니다. 로컬에서 실행하고 테스트할 수 있습니다.
- 라이선스: 없음(모든 권리 보유). 열람용 포트폴리오이며, 코드를 재사용하려면 저작권자의 허락이 필요합니다.

> **약관 문서에 대한 안내**: `supabase/migrations/`에 들어 있는 서비스 이용약관·개인정보 동의 문안은 **초안**입니다. 사업자 정보 칸은 `[ ]`로 비어 있고, 법률 검토를 거치지 않았으며, 환불 규정 문안도 코드의 환불 정책 표와 아직 일치시키지 않았습니다(약관이 정본이고 코드의 환불 계산은 관리자에게 보이는 "제안"입니다). 실제 서비스에 쓰려면 반드시 실제 값과 법률 검토로 교체해야 합니다.

## 설계 방침: 안전을 위한 것과 확장을 위한 것

현재 규모(강사 1인)에는 필요 이상인 구조가 일부 있습니다. 이 프로젝트에서는 그 부분을 의도적으로 구분합니다.

| 구분 | 내용 | 규모와 무관하게 필요한가 |
|---|---|---|
| 안전 | 결제·환불·주문 이력은 원장(append-only)으로 남기고 지우지 않는다. 상태 전이와 금액 규칙은 DB 제약과 트리거로 강제한다. 중요한 쓰기는 `SECURITY DEFINER` RPC로만 하고, 읽기는 RLS로 막는다. 웹훅과 결제 확인은 멱등하게 처리한다. 명령마다 감사 기록을 남긴다. | 필요하다 |
| 확장 대비 | 5개 업무 모듈(회원·주문·결제·이용권·CS)이 테이블을 나눠 소유하고, 모듈 사이의 직접 조회는 경계 가드 테스트가 막는다. 모듈 간 통신은 트랜잭셔널 아웃박스(과거형 사실)로 한다. 모든 쓰기·조회가 하나의 명령 레일을 지난다. 환불 정책은 버전 붙은 표이고 주문에 적용 버전을 고정한다. | 지금 규모에는 과하다. 나중에 이커머스나 대규모 수강 관리로 키울 때 뜯어고치지 않도록 구조와 배선을 미리 깔아둔 것이다. |
| 학습 | 위 기술들을 프레임워크에 맡기지 않고 직접 구현해 보는 것 | 학습 목적 |

"안전"은 돈과 권한이 걸린 데이터가 틀어지지 않게 하는 장치이고, "확장 대비"는 기능이 늘어날 때 수정 범위를 줄이는 배선입니다. 둘을 섞어 평가하지 않기를 권합니다.

## 기술 스택

| 영역 | 기술 |
|---|---|
| 웹 | Next.js 16 (App Router, Server Actions), React 19, TypeScript |
| 스타일 | Tailwind CSS v4, shadcn/ui |
| DB·인증 | Supabase (PostgreSQL, Auth), RLS, PL/pgSQL RPC |
| 결제 | 토스페이먼츠(결제창·웹훅), 로컬 검증용 가짜 PG 서버(`tools/fake-pg`) |
| 수강권 | 디스코드 서버 역할 부여 |
| 테스트 | Vitest, Playwright, SQL 검증 스크립트 |

## 코드 읽는 순서 (제안)

| 보고 싶은 것 | 위치 |
|---|---|
| 모듈 경계와 테이블 소유권 | `lib/architecture/module-map.ts` (`TABLE_OWNER`), `lib/architecture/boundaries.guard.test.ts` |
| 명령 레일(권한·통제 스위치·감사) | `lib/commands/registry.ts`, `lib/commands/rail.ts`, `lib/commands/run-command.ts` |
| 아웃박스와 모듈 간 통신 | `lib/outbox/drain.ts`, `lib/wiring/outbox.ts`, `supabase/migrations/20260911100400_outbox.sql` |
| 결제 흐름·멱등성 | `lib/payment/`, `app/api/webhooks/payment/` |
| 환불 정책 표와 계산 | `lib/shared/refund-policy.ts` |
| DB 규칙(제약·트리거·RPC) | `supabase/migrations/` (140개) |
| DB 검증 | `supabase/tests/integrity_check.sql`, `supabase/tests/rls_check.sql` |
| 화면 계층 | `ui/` (shadcn 컴포넌트, 화면, 로더 분리) |

더 자세한 설명은 아래 문서를 참고하세요.

- [시스템 개요](docs/시스템개요.md)
- [안전성 해설](docs/아키텍처-안전성-해설.md)
- [아키텍처 결정 기록(ADR) 색인](docs/adr/README.md)
- [로컬 개발 환경](docs/로컬개발환경.md)
- [가짜 PG 서버](tools/fake-pg/README.md)

## 실행과 검증

요구 사항: Node.js 22 이상, npm. 아래 1번은 DB 없이 돌아갑니다. 2번 이후는 Docker Desktop과 로컬 Supabase가 필요합니다.

```bash
git clone https://github.com/RadiantCitron/class-desk.git
cd class-desk
npm ci
```

**1. DB 없이 확인 (타입 검사와 단위 테스트)**

```bash
npx tsc --noEmit   # 타입 검사
npm test           # Vitest 단위 테스트 (통합 테스트 제외, 460개)
```

**2. 로컬 DB와 앱 실행**

```bash
npx supabase start               # 로컬 Supabase 시작, 마이그레이션 적용
npx supabase status              # API URL과 키 확인
cp .env.example .env.local       # 위 값으로 채움
npm run dev                      # http://127.0.0.1:3000
```

가짜 PG와 함께 실행하려면 `.env.test.example`을 `.env.test`로 복사한 뒤 `npm run dev:fake`를 실행합니다.

**3. DB 검증 (로컬 Supabase가 떠 있어야 함)**

```bash
docker exec -i supabase_db_class-desk psql -U postgres -d postgres < supabase/tests/integrity_check.sql
docker exec -i supabase_db_class-desk psql -U postgres -d postgres < supabase/tests/rls_check.sql
```

두 스크립트는 하나의 트랜잭션으로 실행하고 끝에 롤백하므로 DB에 흔적을 남기지 않습니다. 모든 줄이 `PASS`로 끝나야 합니다.

**4. 통합·E2E 테스트 (로컬 Supabase 필요)**

```bash
npm run test:integration   # DB를 쓰는 Vitest 통합 테스트
npm run e2e                # Playwright (.env.test 필요)
```

## 상태와 한계

- 직접 운영을 위해 만든 시스템이며, 포트폴리오로 공개한 시점의 소스입니다. 운영 배포 설정과 실제 키·사업자 정보는 들어 있지 않습니다.
- 환경변수 예시는 `.env.example`, 가짜 PG 테스트용 예시는 `.env.test.example`입니다. 실제 키는 저장소에 두지 않습니다.
- 단위 테스트와 타입 검사는 DB 없이 확인할 수 있습니다. SQL·통합·E2E 검증은 로컬 Supabase 환경을 직접 띄워야 합니다.
