-- I단계 — 탈퇴한 ADMIN의 is_admin 통과 차단, 트리거 이름 정리.

-- 1) is_admin()에 탈퇴 조건 추가. RLS 정책이 이 함수 OID를 참조하므로 create or replace만 쓴다.
create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.users
    where auth_user_id = auth.uid() and role = 'ADMIN' and withdrawn_at is null
  );
$$;

-- 2) 트리거 이름 정리(AP9) — 동작은 그대로, 이름만 테이블 개명(orders/order_events, 2026-09-23)에
--    맞춘다. alter trigger는 함수를 다시 붙이지 않고 이름만 바꾼다(로직 변경 없음, 안전).
alter trigger enrollment_events_forbid_app_update_delete
  on public.order_events
  rename to order_events_forbid_app_update_delete;
