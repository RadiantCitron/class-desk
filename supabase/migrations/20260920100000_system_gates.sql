-- 시스템 봉쇄 스위치(킬스위치) — 운영 중 특정 기능만 즉시 잠글 수 있는 밸브(2026-09-20). 결제 시작(PAYMENT)/신규 가입(SIGNUP)/신규 로그인(LOGIN) 3개만 대상으로 한다
-- (축소안). 코드
-- 목록의 authoritative source는 TS(lib/system/gates.ts의 GATE_CODES)이고, 이 테이블은
-- 상태(OPEN/CLOSED)·사유·행위자만 갖는다(manager_permissions와 같은 계보: 목록은 코드가,
-- 값은 DB가 갖는다).

create table public.system_gates (
  code       text primary key,
  status     text not null default 'OPEN' check (status in ('OPEN', 'CLOSED')),
  reason     text,
  changed_by uuid references public.users (id),
  changed_at timestamptz not null default now()
);

insert into public.system_gates (code) values ('PAYMENT'), ('SIGNUP'), ('LOGIN');

-- 행 추가/삭제 금지 — 코드 목록의 주인은 TS다(forbid_users_hard_delete.sql과 같은 "규율이
-- 아니라 구조적으로 불가능하게" 원칙을 행 추가/삭제에도 적용). 시드는 이 트리거를 만들기
-- "전"에 넣었으므로 걸리지 않는다. 상태 변경은 UPDATE만 허용한다.
create or replace function public.system_gates_forbid_insert_delete()
returns trigger
language plpgsql
as $$
begin
  raise exception '시스템 게이트 행은 마이그레이션으로만 추가/삭제할 수 있습니다. 상태 변경은 UPDATE만 가능합니다.'
    using errcode = 'restrict_violation';
end;
$$;

create trigger system_gates_forbid_insert
  before insert on public.system_gates
  for each row execute function public.system_gates_forbid_insert_delete();

create trigger system_gates_forbid_delete
  before delete on public.system_gates
  for each row execute function public.system_gates_forbid_insert_delete();

alter table public.system_gates enable row level security;

-- 로그인한 사용자 전부 조회 가능 — 봉쇄 배너를 보여줘야 한다. insert/update/delete 정책은
-- 두지 않는다 → 쓰기는 service_role만(manager_permissions 선례와 동일. 관리자 화면의
-- setGate()가 runAdminCommand() 안에서 createAdminClient()로 UPDATE한다).
create policy "로그인한 사용자는 게이트 상태 조회 가능"
  on public.system_gates for select
  using (auth.role() = 'authenticated');

-- gate_open() — 게이트 상태 판정의 DB측 단일 지점(complete_signup()의 SIGNUP 이중 방어에서만
-- 쓴다 — 앱 레이어 검사가 우회되더라도 DB에서 한 번 더 막는다). security definer + stable
-- (has_permission()과 같은 이유). coalesce(..., true) = fail-open: 행이 없거나(코드 오타)
-- 조회 자체가 실패해도 통과시킨다 — 봉쇄는 운영 편의 기능이지 보안 경계가 아니며, 보안
-- 경계는 기존 RLS·has_permission()·requireXxx가 그대로 담당한다.
--
-- 실행 권한을 REVOKE하지 않는다(8개 민감 RPC와 다른 점) — has_permission()과 달리 RLS 정책
-- 평가에 쓰이진 않지만, PostgREST로 익명 호출돼도 "게이트가 열려 있는가"라는 저위험 정보만
-- 노출되므로(봉쇄는 보안 경계가 아니다) 굳이 좁힐 이유가 없다. 유일한 호출자인
-- complete_signup()은 SECURITY DEFINER라 내부 호출이 소유자(슈퍼유저) 권한으로 평가되므로,
-- 설령 REVOKE했더라도 그 호출 자체는 영향받지 않았을 것이다.
create or replace function public.gate_open(p_code text)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select coalesce((select status = 'OPEN' from public.system_gates where code = p_code), true);
$$;

-- complete_signup() 재정의 — 맨 앞에 SIGNUP 게이트 검사를 추가한다(앱 레이어의 SIGNUP 게이트
-- 검사와 함께 2중 방어, app/terms/actions.ts 참고). 파라미터 목록은 안 바뀌므로
-- create or replace로 족하다(drop 후 재생성이 필요한 건 파라미터 "개수"가 바뀔 때뿐이다,
-- 2026-09-12 선례). 함수 본문의 나머지는 20260918100000_manager_permissions.sql 5절과 동일.
create or replace function public.complete_signup(
  p_auth_user_id uuid,
  p_discord_id text,
  p_email text,
  p_email_verified boolean,
  p_service_terms_id uuid,
  p_privacy_terms_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
begin
  if not public.gate_open('SIGNUP') then
    raise exception '현재 신규 가입이 일시 중단되었습니다. 잠시 후 다시 시도해 주세요.'
      using errcode = 'insufficient_privilege';
  end if;

  insert into public.users (auth_user_id, discord_id, email, email_verified, role)
  values (p_auth_user_id, p_discord_id, p_email, p_email_verified, 'STUDENT')
  returning id into v_user_id;

  insert into public.terms_agreements (user_id, terms_id) values
    (v_user_id, p_service_terms_id),
    (v_user_id, p_privacy_terms_id);

  return v_user_id;
end;
$$;

-- record_payment_event()는 절대 손대지 않는다 — 결제 웹훅이 이 RPC를 쓴다. PAYMENT 게이트가
-- 닫혀 있어도 이미 시작된 결제의 웹훅 기록은 막지 않는다(2026-09-20 "웹훅은
-- 절대 막지 않는다").
