-- 개설강의·상품 상태 전이를 DB 함수로, 전이 트리거로 사유 강제.

-- 1-1. set_course_offering_status()
create function public.set_course_offering_status(
  p_offering_id uuid,
  p_next_status text,
  p_reason text,
  p_actor uuid
)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_current text;
begin
  if p_next_status not in ('OPEN', 'CLOSED') then
    raise exception '알 수 없는 상태입니다: %', p_next_status;
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception '% 사유를 입력해야 합니다.', case when p_next_status = 'CLOSED' then '마감' else '재개' end;
  end if;

  select status into v_current from public.course_offerings where id = p_offering_id for update;
  if v_current is null then
    raise exception '개설강의를 찾을 수 없습니다.';
  end if;
  if v_current = p_next_status then
    raise exception '이미 % 상태입니다.', case when p_next_status = 'CLOSED' then '마감' else '재개' end;
  end if;

  update public.course_offerings
  set status = p_next_status,
      status_reason = p_reason,
      status_changed_by = p_actor,
      status_changed_at = clock_timestamp()
  where id = p_offering_id;
end;
$$;

revoke execute on function public.set_course_offering_status(uuid, text, text, uuid)
  from public, anon;
grant execute on function public.set_course_offering_status(uuid, text, text, uuid)
  to authenticated, service_role;

-- 1-2. set_product_status()
create function public.set_product_status(
  p_product_id uuid,
  p_next_status text,
  p_reason text,
  p_actor uuid
)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_current text;
begin
  if p_next_status not in ('OPEN', 'CLOSED') then
    raise exception '알 수 없는 상태입니다: %', p_next_status;
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception '% 사유를 입력해야 합니다.', case when p_next_status = 'CLOSED' then '마감' else '재개' end;
  end if;

  select status into v_current from public.products where id = p_product_id for update;
  if v_current is null then
    raise exception '상품을 찾을 수 없습니다.';
  end if;
  if v_current = p_next_status then
    raise exception '이미 % 상태입니다.', case when p_next_status = 'CLOSED' then '마감' else '재개' end;
  end if;

  update public.products
  set status = p_next_status,
      status_reason = p_reason,
      status_changed_by = p_actor,
      status_changed_at = clock_timestamp()
  where id = p_product_id;
end;
$$;

revoke execute on function public.set_product_status(uuid, text, text, uuid)
  from public, anon;
grant execute on function public.set_product_status(uuid, text, text, uuid)
  to authenticated, service_role;

-- 1-3. 전이 트리거
create function public.enforce_status_transition_reason()
returns trigger
language plpgsql
as $$
begin
  if new.status is distinct from old.status then
    if new.status_reason is null or btrim(new.status_reason) = '' then
      raise exception '상태를 바꾸려면 사유가 필요합니다.';
    end if;
    if new.status_changed_by is null then
      raise exception '상태를 바꾸려면 행위자가 필요합니다.';
    end if;
    if new.status_changed_at is null or new.status_changed_at is not distinct from old.status_changed_at then
      raise exception '상태를 바꾸려면 새 변경 시각이 필요합니다.';
    end if;
  end if;
  return new;
end;
$$;

create trigger course_offerings_status_transition_reason
  before update on public.course_offerings
  for each row execute function public.enforce_status_transition_reason();

create trigger products_status_transition_reason
  before update on public.products
  for each row execute function public.enforce_status_transition_reason();

-- 1-4. grants CHECK
create function public.grants_shape_ok(p_grants jsonb)
returns boolean
language sql
immutable
as $$
  select p_grants is not null
    and jsonb_typeof(p_grants) = 'array'
    and not exists (
      select 1 from jsonb_array_elements(p_grants) elem
      where not (
        (elem->>'type') in ('COURSE_ACCESS', 'SOURCE_DOWNLOAD', 'DISCORD_ROLE')
        and (
          (elem->>'type' <> 'DISCORD_ROLE') or jsonb_typeof(elem->'discord_role_id') = 'string'
        )
        and (
          (elem->>'type' <> 'SOURCE_DOWNLOAD') or jsonb_typeof(elem->'blob_pathname') = 'string'
        )
      )
    );
$$;

do $$
declare
  v_bad integer;
begin
  select count(*) into v_bad from public.course_offerings where not public.grants_shape_ok(grants);
  if v_bad > 0 then
    raise exception 'course_offerings.grants 모양이 맞지 않는 행이 %건 있습니다 — 마이그레이션을 중단합니다.', v_bad;
  end if;
  select count(*) into v_bad from public.products where not public.grants_shape_ok(grants);
  if v_bad > 0 then
    raise exception 'products.grants 모양이 맞지 않는 행이 %건 있습니다 — 마이그레이션을 중단합니다.', v_bad;
  end if;
end $$;

alter table public.course_offerings add constraint course_offerings_grants_shape
  check (public.grants_shape_ok(grants));
alter table public.products add constraint products_grants_shape
  check (public.grants_shape_ok(grants));
