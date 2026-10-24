-- 디스코드 채팅방 입장 기능 8단계(2026-09-27) — 강의(회차)마다 다른 "방(채널)" 정보를
-- course_offerings.grants에 선택 필드로 추가한다. discord_role_id와 달리 필수는 아니다
-- (역할 부여는 이 필드 없이도 이미 동작하고, 채널 딥링크는 화면 편의 기능일 뿐이다).
-- 서버는 시스템 전체에 1개뿐이므로(DISCORD_GUILD_ID) 여기는 채널ID만 저장하고, 딥링크는
-- 화면에서 그 값과 조합해 만든다.

create or replace function public.grants_shape_ok(p_grants jsonb)
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
          not (elem ? 'discord_channel_id') or jsonb_typeof(elem->'discord_channel_id') = 'string'
        )
        and (
          (elem->>'type' <> 'SOURCE_DOWNLOAD') or jsonb_typeof(elem->'blob_pathname') = 'string'
        )
      )
    );
$$;
