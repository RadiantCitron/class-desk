-- 회차에서 파생되는 값(총/지난/다음 회차)을 한 곳에 모은다.
--
--  · offering_session_stats(offering, today): 활성(deactivated_at 없는) 회차만, 날짜는 한국 달력 날짜, 지난 회차 = session_date <= 오늘(당일 포함),
--    다음 회차 = 오늘 이후 가장 이른 날짜. TS 쪽 정의는 lib/shared/session-progress.ts — 같은 정의가 두 곳이므로 바꾸면 같이 고친다.
--  · on_payment_refunded: 취소 사건 payload에 total_sessions·past_sessions를 더 기록하고(S-4a가 회차 데이터가 없어 미룬 것),
--    first_class_date는 활성 회차의 첫 날짜에서 가져온다(회차가 없는 옛 개설강의는 캐시 opens_at의 날짜). 키 추가뿐이라 이미 쌓인 사건과 호환된다.
--    그 밖의 분기·가드는 S-4a(20261008150000)와 같다.
--  새 함수 grant는 같은 파일에.

create function public.offering_session_stats(
  p_offering_id uuid,
  p_today date default ((now() at time zone 'Asia/Seoul')::date)
)
returns table (total_count integer, past_count integer, first_date date, last_date date, next_date date)
language sql
stable
set search_path = public
as $$
  select
    count(*)::integer,
    (count(*) filter (where s.session_date <= p_today))::integer,
    min(s.session_date),
    max(s.session_date),
    min(s.session_date) filter (where s.session_date > p_today)
  from public.course_sessions s
  where s.course_offering_id = p_offering_id
    and s.deactivated_at is null;
$$;

revoke execute on function public.offering_session_stats(uuid, date) from public, anon;
grant execute on function public.offering_session_stats(uuid, date) to authenticated, service_role;

CREATE OR REPLACE FUNCTION public.on_payment_refunded(p_payment_event_id uuid, p_order_id uuid, p_provider text, p_amount integer, p_currency text, p_cause text DEFAULT NULL::text, p_reason text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_order record;
  v_new_total integer;
  v_partial boolean;
  v_first_class_date date;
  v_total_sessions integer;
  v_past_sessions integer;
begin
  select id, user_id, status, payment_status, final_amount, course_offering_id,
         refunded_amount, refunded_event_ids
    into v_order
  from public.orders
  where id = p_order_id
  for update;

  if p_payment_event_id = any(v_order.refunded_event_ids)
     or exists (
       select 1 from public.dead_letters
       where payload->>'handler' = 'on_payment_refunded'
         and payload->>'payment_event_id' = p_payment_event_id::text
     ) then
    return;
  end if;

  -- 이미 취소된 주문(탈퇴 등)에 환불이 뒤늦게 오면 금액을 반영하지 않고 DLQ로 보낸다(§17-12).
  -- 단, 앞선 부분 환불로 끝난 주문(PARTIALLY_REFUNDED)에 남은 금액 환불이 오는 것은 정상이라 누적 반영한다.
  if v_order.status = 'CANCELLED' and v_order.payment_status is distinct from 'PARTIALLY_REFUNDED' then
    insert into public.dead_letters (source, payload, error_message)
    values (
      p_provider,
      jsonb_build_object('handler', 'on_payment_refunded', 'payment_event_id', p_payment_event_id, 'order_id', v_order.id),
      '이미 취소된 주문(탈퇴 등)에 환불 이벤트가 들어옴(상태 반영 안 함, 대사 확인 필요) — order_id='
        || v_order.id::text || ', payment_event_id=' || p_payment_event_id::text
    );
    return;
  end if;

  if v_order.payment_status not in ('PAID', 'PARTIALLY_REFUNDED') then
    insert into public.dead_letters (source, payload, error_message)
    values (
      p_provider,
      jsonb_build_object('handler', 'on_payment_refunded', 'payment_event_id', p_payment_event_id, 'order_id', v_order.id),
      '결제완료 상태가 아닌 신청 건에 환불 이벤트가 들어옴(상태 반영 안 함) — order_id='
        || v_order.id::text
        || ', payment_status=' || coalesce(v_order.payment_status, 'null')
        || ', payment_event_id=' || p_payment_event_id::text
    );
    return;
  end if;

  v_new_total := v_order.refunded_amount + coalesce(p_amount, 0);

  if p_currency is distinct from 'KRW'
     or p_amount is null or p_amount <= 0
     or v_order.final_amount is null
     or v_new_total > v_order.final_amount then
    insert into public.dead_letters (source, payload, error_message)
    values (
      p_provider,
      jsonb_build_object('handler', 'on_payment_refunded', 'payment_event_id', p_payment_event_id, 'order_id', v_order.id),
      '환불 금액을 반영할 수 없음(통화 불일치·0 이하·환불 누적 금액 초과 — 상태 반영 안 함, 대사 확인 필요) — order_id='
        || v_order.id::text
        || ', 결제액=' || coalesce(v_order.final_amount::text, 'null')
        || ', 기존 환불 누적=' || v_order.refunded_amount::text
        || ', 이번 환불=' || coalesce(p_amount::text, 'null')
        || ', currency=' || coalesce(p_currency, 'null')
        || ', payment_event_id=' || p_payment_event_id::text
    );
    return;
  end if;

  v_partial := v_new_total < v_order.final_amount;

  update public.orders
  set payment_status = case when v_partial then 'PARTIALLY_REFUNDED' else 'REFUNDED' end,
      refunded_at = case when v_partial then refunded_at else now() end,
      refunded_amount = v_new_total,
      refunded_event_ids = refunded_event_ids || p_payment_event_id,
      status = 'CANCELLED',
      cancelled_at = coalesce(cancelled_at, now())
  where id = v_order.id;

  -- 종료 사건·좌석 반환·회수 요청은 주문이 처음 끝날 때 한 번만(이미 끝난 주문의 추가 환불은 금액만 누적).
  if v_order.status is distinct from 'CANCELLED' and v_order.status is distinct from 'REJECTED' then
    -- 총/지난 회차와 첫 수업 날짜는 활성 회차에서 계산한다(offering_session_stats — 당일 포함, 한국 날짜). 회차가 없는 옛 개설강의는
    -- 캐시 opens_at의 날짜로 대신한다(총·지난은 0).
    if v_order.course_offering_id is not null then
      select s.first_date, s.total_count, s.past_count
        into v_first_class_date, v_total_sessions, v_past_sessions
      from public.offering_session_stats(v_order.course_offering_id) s;
      if v_first_class_date is null then
        select (opens_at at time zone 'Asia/Seoul')::date into v_first_class_date
        from public.course_offerings
        where id = v_order.course_offering_id;
      end if;
    end if;

    insert into public.order_events (event_type, actor, order_id, payload)
    values (
      'CANCELLED', 'SYSTEM', v_order.id,
      jsonb_build_object(
        'cause', p_cause,
        'reason', p_reason,
        'refund_amount', p_amount,
        'refunded_total', v_new_total,
        'final_amount', v_order.final_amount,
        'partial', v_partial,
        'first_class_date', v_first_class_date,
        'total_sessions', v_total_sessions,
        'past_sessions', v_past_sessions
      )
    );

    if v_order.course_offering_id is not null then
      perform public.release_course_offering_seat(v_order.course_offering_id);
    end if;

    insert into public.outbox_messages (topic, payload)
    values (
      'ORDER_REFUNDED',
      jsonb_build_object('order_id', v_order.id, 'user_id', v_order.user_id, 'payment_event_id', p_payment_event_id)
    );
  end if;
end;
$function$;
