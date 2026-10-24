-- DB 구조 재정립 6단계(2026-09-23) — 이용권 정리(D12·N15·G10).
-- 자격형(COURSE_ACCESS/DISCORD_ROLE) "사용하기" 버튼 제거는 앱 코드만의 변경이라 DB
-- 마이그레이션이 필요 없다(entitlement_uses·consume_entitlement()는 소모형(SOURCE_DOWNLOAD)이
-- 계속 쓴다). 여기서는 이름과 실제로 하는 일이 다르던 DISCORD_INVITE(초대 링크를 만드는 게
-- 아니라 서버 역할을 부여한다, N15)를 DISCORD_ROLE로 바로잡는다.

-- 1. entitlements.type 데이터부터 갱신(CHECK가 걸려 있으니 CHECK보다 먼저 바꿔야 통과한다).
update public.entitlements set type = 'DISCORD_ROLE' where type = 'DISCORD_INVITE';

alter table public.entitlements drop constraint entitlements_type_check;
alter table public.entitlements add constraint entitlements_type_check
  check (type = any (array['COURSE_ACCESS', 'SOURCE_DOWNLOAD', 'DISCORD_ROLE']));

-- 2. course_offerings.grants/products.grants는 jsonb 배열이라 CHECK가 아니라 데이터 자체를
--    고쳐야 한다 — 배열 안에서 type='DISCORD_INVITE'인 원소만 골라 값을 바꾼다.
update public.course_offerings
set grants = (
  select jsonb_agg(
    case when elem->>'type' = 'DISCORD_INVITE'
      then jsonb_set(elem, '{type}', '"DISCORD_ROLE"')
      else elem
    end
  )
  from jsonb_array_elements(grants) elem
)
where grants @> '[{"type": "DISCORD_INVITE"}]'::jsonb;

update public.products
set grants = (
  select jsonb_agg(
    case when elem->>'type' = 'DISCORD_INVITE'
      then jsonb_set(elem, '{type}', '"DISCORD_ROLE"')
      else elem
    end
  )
  from jsonb_array_elements(grants) elem
)
where grants @> '[{"type": "DISCORD_INVITE"}]'::jsonb;
