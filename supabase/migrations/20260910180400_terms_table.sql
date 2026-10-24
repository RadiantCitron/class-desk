-- 약관을 코드 상수(text 버전 문자열)가 아니라 실제 DB 테이블로 관리한다(사용자 제안 채택).
-- type은 사용자가 나열한 4종(PRIVACY_USE/THIRD_PARTY_SHARE/MARKETING_OPT_IN/AI_CROSS_BORDER_TRANSFER)에
-- 더해, 기존에 이미 구현되어 있던 "가입 시 서비스 이용약관"(SERVICE_USE)을 보존하기 위해 추가했다.
-- 실제 동의 수집 로직이 있는 건 SERVICE_USE(가입 시)/PRIVACY_USE(신청 시, 이중 동의 원칙)뿐이고, 나머지 3종은 향후 확장을 위해 타입만 열어둔 상태다(지금 새 동의 UI를 만들지는 않음).

create table public.terms (
  id uuid primary key default gen_random_uuid(),
  type text not null check (
    type in ('SERVICE_USE', 'PRIVACY_USE', 'THIRD_PARTY_SHARE', 'MARKETING_OPT_IN', 'AI_CROSS_BORDER_TRANSFER')
  ),
  version text not null,
  content text not null,
  effective_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (type, version)
);

alter table public.terms enable row level security;

create policy "로그인한 사용자는 약관 조회 가능"
  on public.terms for select
  using (auth.role() = 'authenticated');

create policy "관리자만 약관 등록/수정 가능"
  on public.terms for all
  using (is_admin())
  with check (is_admin());

-- 기존 코드 상수(lib/terms.ts의 SERVICE_TERMS_VERSION/APPLICATION_PRIVACY_TERMS_VERSION)와
-- 매칭되는 버전을 그대로 시드한다. content는 기존 app/terms/page.tsx에 하드코딩돼 있던 placeholder
-- 문구를 그대로 옮긴 것이며, 실제 서비스 오픈 전 전문으로 교체가 필요하다(기존에도 있던 요건).
insert into public.terms (type, version, content) values
  (
    'SERVICE_USE',
    'SERVICE_TERMS_v1',
    '본 서비스 이용 및 계정 식별 목적으로 디스코드 ID, 이메일을 수집합니다. 수집한 정보는 수강 신청·결제·환불 이력 관리 목적으로만 사용됩니다.

탈퇴 시 사이트 접속 및 수강 페이지 접근이 즉시 제한되며, 수강 및 결제 분쟁 대응을 위해 신청 기록은 탈퇴일로부터 3년간 보관 후 파기됩니다.

※ 이 문구는 placeholder입니다. 실제 서비스 오픈 전 전문으로 교체해야 합니다.'
  ),
  (
    'PRIVACY_USE',
    'APPLICATION_PRIVACY_v1',
    '수강 신청(Tally 폼) 제출 시 결제 처리 및 수강 관리를 위한 개인정보(이름, 연락처, 이메일 등) 수집·이용에 동의한 것으로 간주합니다.

※ 이 문구는 placeholder입니다. 실제 Tally 폼 약관 전문과 일치하도록 교체해야 합니다.'
  )
on conflict (type, version) do nothing;

-- terms_agreements.terms_version(text) -> terms_id(FK)로 전환.
-- 기존 로컬 DB에 실제 로그인 테스트로 생성된 행이 남아있을 수 있으므로,
-- 데이터를 버리지 않고 안전하게 백필한다.
alter table public.terms_agreements
  add column terms_id uuid references public.terms (id) on delete restrict;

update public.terms_agreements ta
set terms_id = t.id
from public.terms t
where ta.terms_version = t.version
  and ta.terms_id is null;

do $$
begin
  if exists (select 1 from public.terms_agreements where terms_id is null) then
    raise exception 'terms_agreements에 terms_id로 매핑되지 않은 레거시 행이 있습니다. 수동으로 확인 후 마이그레이션을 다시 실행하세요.';
  end if;
end $$;

alter table public.terms_agreements
  alter column terms_id set not null,
  drop column terms_version;

create index on public.terms_agreements (terms_id);
