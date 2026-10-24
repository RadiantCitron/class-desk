-- 버그 수정: apply_for_offering 오버로드 정리.
--
-- 20260912100100_catalog_soft_delete.sql이 drop 없이 옛 시그니처(uuid,uuid,uuid)를
-- create or replace로 되살려, 20260911170000_conditional_terms.sql이 만든
-- (uuid,uuid,uuid[]) 버전과 공존하게 된 상태였다. 부작용 두 가지:
--  (1) 앱(app/student/apply/[offeringId]/actions.ts)은 p_terms_ids 배열로 호출하므로
--      실제로는 deleted_at 검사가 없는 버전이 선택된다 — "숨긴 개설강의는 URL 직접
--      접근으로도 신청 불가"라고 문서화했지만 실제로는 뚫려 있었다.
--  (2) supabase/tests/integrity_check.sql의 TEST13이 3번째 인자로 타입 없는 null을 넘겨
--      "function is not unique" 모호성 에러(42883)를 내는데, 그 파일의 광범위한
--      "exception when others"가 이를 삼켜 거짓 PASS를 출력한다(별도 마이그레이션에서
--      integrity_check.sql 자체를 수정해 이 문제도 함께 바로잡는다).

drop function if exists public.apply_for_offering(uuid, uuid, uuid);

create or replace function public.apply_for_offering(
  p_user_id uuid,
  p_offering_id uuid,
  p_terms_ids uuid[]
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_offering record;
  v_reserved boolean;
  v_enrollment_id uuid;
  v_terms_id uuid;
begin
  select id, price into v_offering
  from public.course_offerings
  where id = p_offering_id
    and status = 'OPEN'
    and deleted_at is null
    and now() >= opens_at
    and (ends_at is null or now() <= ends_at);

  if v_offering.id is null then
    raise exception '신청할 수 없는 개설강의입니다.';
  end if;

  select public.reserve_course_offering_seat(p_offering_id) into v_reserved;
  if not coalesce(v_reserved, false) then
    raise exception '정원이 마감되어 신청할 수 없습니다.';
  end if;

  begin
    insert into public.enrollments (user_id, course_offering_id, list_price, final_amount)
    values (p_user_id, p_offering_id, v_offering.price, v_offering.price)
    returning id into v_enrollment_id;
  exception when unique_violation then
    perform public.release_course_offering_seat(p_offering_id);
    raise exception '이미 신청한 강의입니다.';
  end;

  insert into public.enrollment_events (user_id, course_offering_id, event_type, actor, payload)
  values (p_user_id, p_offering_id, 'APPLIED', 'SYSTEM', '{}'::jsonb);

  if p_terms_ids is not null then
    foreach v_terms_id in array p_terms_ids loop
      insert into public.terms_agreements (user_id, terms_id) values (p_user_id, v_terms_id);
    end loop;
  end if;

  return v_enrollment_id;
end;
$$;
