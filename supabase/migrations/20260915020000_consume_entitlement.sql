-- 권한 소비(다운로드 클릭 등)를 읽기→판단→insert 세 단계로 나누면 더블클릭이 횟수를
-- 두 번 쓸 수 있다. complete_signup()/apply_for_offering()과 같이 한 트랜잭션에서
-- 행을 잠그고 횟수를 센 뒤 entitlement_uses에 1건만 남긴다(2026-09-15 수정하기로 한 것 D).
-- 횟수 자체는 기존처럼 entitlement_uses 행 개수다. download_count 컬럼은 만들지 않는다.

create or replace function public.consume_entitlement(
  p_entitlement_id uuid,
  p_user_id uuid,
  p_ip text default null,
  p_user_agent text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ent record;
  v_use_count integer;
begin
  select id, user_id, type, expires_at, max_uses, revoked_at, metadata
    into v_ent
  from public.entitlements
  where id = p_entitlement_id
  for update;

  if not found then
    raise exception '권한을 찾을 수 없습니다.';
  end if;

  if v_ent.user_id <> p_user_id then
    raise exception '본인의 권한이 아닙니다.';
  end if;

  if v_ent.revoked_at is not null then
    raise exception '회수된 권한입니다.';
  end if;

  if v_ent.expires_at is not null and v_ent.expires_at < now() then
    raise exception '기간이 만료된 권한입니다.';
  end if;

  if v_ent.max_uses is not null then
    select count(*) into v_use_count
    from public.entitlement_uses
    where entitlement_id = p_entitlement_id;

    if v_use_count >= v_ent.max_uses then
      raise exception '사용 가능 횟수를 모두 사용했습니다.';
    end if;
  end if;

  insert into public.entitlement_uses (entitlement_id, ip, user_agent)
  values (p_entitlement_id, p_ip, p_user_agent);

  return jsonb_build_object(
    'id', v_ent.id,
    'type', v_ent.type,
    'metadata', coalesce(v_ent.metadata, '{}'::jsonb)
  );
end;
$$;

-- 신뢰 경계: 브라우저/anon 키가 직접 호출하지 않는다. Next.js 서버가
-- requireWritableProfile()로 세션을 확인한 뒤 service_role로만 호출한다.
