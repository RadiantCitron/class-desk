-- public.users.id가 auth.users.id를 참조하던 종속을 끊는다.
--
-- 문제: public.users.id -> auth.users(id) ON DELETE CASCADE 때문에, Supabase 인증 계정을
-- 하나 지우면 우리 회원부 행이 함께 사라진다(신청/결제 이력이 있는 계정은 RESTRICT에 막혀
-- 에러가 나지만, 이력이 없는 계정은 그대로 하드 삭제된다). "회원 탈퇴는 소프트 삭제만,
-- 하드 삭제 절대 금지"라는 이 저장소의 최상위 원칙이 Supabase 내부
-- 테이블 하나에 인질로 잡혀 있던 셈이다.
--
-- 해결: 우리 회원부 PK(public.users.id)를 독자 발급하고, 인증 계정 id는 FK 없는 브릿지
-- 컬럼(auth_user_id)으로만 들고 있는다. RLS 정책 표현식 안에서는 auth.uid()밖에 알 수 없으므로
-- (디스코드 id 같은 외부 식별자는 정책에서 접근 불가) 세션↔프로필 매핑은 이 컬럼을 경유한다.
--
-- 이 파일은 반드시 통째로 한 트랜잭션이어야 한다. 부분 적용되면 "본인 프로필이 안 보이는"
-- 상태가 된다.

-- =========================================================
-- 1. 브릿지 컬럼 추가 + 백필
--    지금까지 두 값이 항상 같았으므로(id를 auth.users.id로 받아 넣어왔다) 그대로 복사한다.
-- =========================================================
alter table public.users add column auth_user_id uuid;

update public.users set auth_user_id = id where auth_user_id is null;

-- "인증 계정 하나당 프로필 하나" — 지금까지 users_pkey가 우연히 보장하던 것을 명시적 제약으로
-- 승격시킨다(id가 독자 발급으로 바뀌면 pkey는 더 이상 이 역할을 못 한다).
-- NOT NULL로 두지 않는 이유: 인증 계정이 삭제된 회원(auth_user_id가 가리킬 대상이 없어진
-- 상태)의 프로필 행도 그대로 살아 있어야 하기 때문. NULL은 어떤 세션과도 매칭되지 않으므로
-- RLS 관점에서 안전하다(NULL = auth.uid() -> NULL -> false, fail-closed).
alter table public.users
  add constraint users_auth_user_id_key unique (auth_user_id);

-- =========================================================
-- 2. FK 제거 — 이 마이그레이션의 본체
--    제약 이름을 하드코딩하지 않고 찾아서 지운다. 못 찾으면 예외를 던져 조용한 no-op를 막는다.
-- =========================================================
do $$
declare
  v_constraint text;
begin
  select con.conname into v_constraint
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace nsp on nsp.oid = rel.relnamespace
  join pg_class frel on frel.oid = con.confrelid
  join pg_namespace fnsp on fnsp.oid = frel.relnamespace
  where nsp.nspname = 'public' and rel.relname = 'users'
    and fnsp.nspname = 'auth' and frel.relname = 'users'
    and con.contype = 'f';

  if v_constraint is null then
    raise exception 'public.users -> auth.users FK를 찾지 못했습니다. 스키마 상태를 확인하세요.';
  end if;

  execute format('alter table public.users drop constraint %I', v_constraint);
end $$;

-- =========================================================
-- 3. id 독자 발급
-- =========================================================
alter table public.users alter column id set default gen_random_uuid();

-- =========================================================
-- 4. 세션 -> 우리 프로필 id 변환 헬퍼
--    security definer인 이유는 is_admin()과 같다(20260910120000_fix_users_rls_recursion.sql):
--    RLS 정책 안에서 users를 조회해야 하는데 그냥 조회하면 users의 정책이 다시 평가되어
--    무한 재귀(42P17)가 난다. definer는 소유자 권한으로 실행되어 RLS를 우회하므로 재귀가 없다.
-- =========================================================
create or replace function public.current_profile_id()
returns uuid
language sql
security definer
set search_path = public
stable
as $$
  select id from public.users where auth_user_id = auth.uid();
$$;

comment on function public.current_profile_id() is
  '현재 세션(auth.uid())에 대응하는 public.users.id. 가입 미완료/비로그인이면 NULL. RLS 정책은 반드시 이 함수를 경유해서만 소유자를 판정한다.';

-- 탈퇴 여부(withdrawn_at)는 여기서 거르지 않는다 — 이 함수는 "신원 확인"이지 "인가"가 아니다.
-- 탈퇴자 차단은 proxy.ts와 requireProfile()(lib/supabase/identity.ts)이 담당한다(관심사 분리).

-- =========================================================
-- 5. is_admin() 재작성
--    create or replace이므로 이 함수를 호출하는 관리자 정책 14개는 건드릴 필요가 없다
--    (정책은 함수 OID를 참조하고 OR REPLACE는 OID를 보존한다).
--    drop ... cascade는 절대 쓰면 안 된다 — 정책 14개가 함께 삭제되고, 그 상태에서는
--    관리자 화면이 에러 없이 조용히 빈 화면이 된다.
-- =========================================================
create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.users
    where auth_user_id = auth.uid() and role = 'ADMIN'
  );
$$;

-- =========================================================
-- 6. auth.uid()를 직접 쓰던 "본인 것만" 정책 8개 재작성
--
--    (select ...) 래핑은 Supabase RLS 성능 관례다 — 래핑하지 않으면 current_profile_id()가
--    행마다 호출되어 목록 조회가 O(n)번 users를 읽는다. 래핑하면 InitPlan으로 한 번만 평가된다.
--
--    users 자신의 정책만 헬퍼를 쓰지 않고 컬럼을 직접 비교한다: 헬퍼를 쓰면 재귀 회피가
--    security definer라는 함수 속성에 의존하지만, 컬럼 직접 비교는 표현식 모양 자체로
--    재귀가 불가능하다(과거 42P17 사고 이력이 있는 저장소라 의존을 하나라도 줄인다).
-- =========================================================

drop policy "본인 프로필만 조회 가능" on public.users;
create policy "본인 프로필만 조회 가능"
  on public.users for select
  using (auth_user_id = (select auth.uid()));

drop policy "본인 동의 이력만 조회 가능" on public.terms_agreements;
create policy "본인 동의 이력만 조회 가능"
  on public.terms_agreements for select
  using (user_id = (select public.current_profile_id()));

drop policy "본인 동의 이력만 등록 가능" on public.terms_agreements;
create policy "본인 동의 이력만 등록 가능"
  on public.terms_agreements for insert
  with check (user_id = (select public.current_profile_id()));

drop policy "본인 관련 이벤트만 조회 가능" on public.enrollment_events;
create policy "본인 관련 이벤트만 조회 가능"
  on public.enrollment_events for select
  using (user_id = (select public.current_profile_id()));

drop policy "본인 신청 내역만 조회 가능" on public.enrollments;
create policy "본인 신청 내역만 조회 가능"
  on public.enrollments for select
  using (user_id = (select public.current_profile_id()));

-- 단독 구매(user_id 직접 경로)와 수강신청 경유 경로 둘 다 유지한다.
drop policy "본인 결제 이력만 조회 가능" on public.payment_events;
create policy "본인 결제 이력만 조회 가능"
  on public.payment_events for select
  using (
    user_id = (select public.current_profile_id())
    or exists (
      select 1 from public.enrollments e
      where e.id = payment_events.enrollment_id
        and e.user_id = (select public.current_profile_id())
    )
  );

drop policy "본인 권한만 조회 가능" on public.entitlements;
create policy "본인 권한만 조회 가능"
  on public.entitlements for select
  using (user_id = (select public.current_profile_id()));

drop policy "본인 권한의 사용 이력만 조회 가능" on public.entitlement_uses;
create policy "본인 권한의 사용 이력만 조회 가능"
  on public.entitlement_uses for select
  using (exists (
    select 1 from public.entitlements ent
    where ent.id = entitlement_uses.entitlement_id
      and ent.user_id = (select public.current_profile_id())
  ));

-- =========================================================
-- 7. complete_signup() 재설계
--    이제 id를 외부에서 받지 않고 DB가 발급한다. 반환 타입이 void -> uuid로 바뀌므로
--    create or replace로는 교체할 수 없다(반환 타입 변경 불가) — 반드시 먼저 drop한다.
--
--    파라미터도 p_user_id -> p_auth_user_id로 개명한다: PostgREST는 이름으로 인자를 넘기므로
--    호출자(app/terms/actions.ts)가 옛 키를 쓰면 즉시 "함수를 찾을 수 없음" 에러가 난다.
--    조용히 잘못된 값이 들어가는 것보다 요란하게 실패하는 편이 낫다(의도적 개명).
--
--    규칙: p_user_id는 언제나 public.users.id를 뜻한다. 인증 계정 id가 등장하는 파라미터는
--    이 함수의 p_auth_user_id 하나뿐이다.
-- =========================================================
drop function public.complete_signup(uuid, text, text, boolean, text, uuid, uuid);

create or replace function public.complete_signup(
  p_auth_user_id uuid,
  p_discord_id text,
  p_email text,
  p_email_verified boolean,
  p_role text,
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
  insert into public.users (auth_user_id, discord_id, email, email_verified, role)
  values (p_auth_user_id, p_discord_id, p_email, p_email_verified, p_role)
  returning id into v_user_id;

  insert into public.terms_agreements (user_id, terms_id) values
    (v_user_id, p_service_terms_id),
    (v_user_id, p_privacy_terms_id);

  return v_user_id;
end;
$$;

-- 중복 가입 방어선이 바뀌었다는 점에 유의: 예전엔 users_pkey(외부에서 넘긴 id)가 막았지만,
-- 이제 id는 매번 새로 발급되므로 pkey는 절대 충돌하지 않는다. 대신
-- users_auth_user_id_key(같은 인증 계정으로 중복 제출)와 users_discord_id_key(같은 디스코드
-- 계정)가 막는다. 둘 다 unique_violation으로 올라오고 함수 전체가 원자적으로 롤백된다.
