-- F-2: payment_events.raw_payload에 남은 페이앱 정적 연동 키(linkkey/linkval/userid) 제거.
-- event_log_forbid_app_update_delete는 anon/authenticated/service_role만 막으므로
-- 마이그레이션 역할(postgres)에서는 UPDATE 가능.

update public.payment_events
set raw_payload = (raw_payload - 'linkkey' - 'linkval' - 'userid')
where raw_payload ? 'linkkey'
   or raw_payload ? 'linkval'
   or raw_payload ? 'userid';

-- dead_letters.payload가 jsonb 객체이고 키가 있으면 경우
update public.dead_letters
set payload = (payload - 'linkkey' - 'linkval' - 'userid')
where jsonb_typeof(payload) = 'object'
  and (
    payload ? 'linkkey'
    or payload ? 'linkval'
    or payload ? 'userid'
  );

-- dead_letters.payload.rawBody가 form 문자열인 경우 — 키=값 조각을 지운다
update public.dead_letters
set payload = jsonb_set(
  payload,
  '{rawBody}',
  to_jsonb(
    trim(both '&' from regexp_replace(
      regexp_replace(
        regexp_replace(payload->>'rawBody', '(^|&)linkkey=[^&]*', '', 'g'),
        '(^|&)linkval=[^&]*', '', 'g'
      ),
      '(^|&)userid=[^&]*', '', 'g'
    ))
  )
)
where payload ? 'rawBody'
  and jsonb_typeof(payload->'rawBody') = 'string'
  and (
    (payload->>'rawBody') like '%linkkey=%'
    or (payload->>'rawBody') like '%linkval=%'
    or (payload->>'rawBody') like '%userid=%'
  );
