-- entitlements(구매/신청 건마다 부여되는 권한)에 사람이 부르기 쉬운 짧은 코드(access_code)를
-- 추가한다. entitlements.id(UUID)는 이미 시스템 내부적으로 고유하지만 사람이 타이핑/구술하기엔
-- 불편해서, 고객 문의 대응·영수증 표시·향후 2차 인증 등 내부 용도로 쓸 별도 코드를 둔다
-- (2026-09-11 — "사람 단위가 아니라 entitlement(구매) 단위로", "디스코드 봇엔
-- 안 쓰지만 내 서버에서는 쓸모 있다"). 형식은 흔한 소프트웨어 라이선스 키 관행을 따른다:
-- 16자, Crockford Base32(혼동되는 0/O, 1/I/L, U 제외 — lib/entitlements/accessCode.ts 참고).
-- 실제 생성은 애플리케이션 코드(lib/outbox/drain.ts의 grantEntitlements())가 담당하고, 여기서는
-- 컬럼/제약과 (있다면) 기존 행의 백필만 처리한다.

alter table public.entitlements add column access_code text;

-- 기존 행(있다면)의 백필 — 이 시점엔 정식 포맷 생성기가 DB에 없으므로 임시로 UUID 기반 16자
-- 16진수 코드를 채운다. 이후 신규 행은 전부 애플리케이션이 정식 포맷(Crockford Base32)으로 채운다.
update public.entitlements
set access_code = upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 16))
where access_code is null;

alter table public.entitlements
  alter column access_code set not null,
  add constraint entitlements_access_code_key unique (access_code);
