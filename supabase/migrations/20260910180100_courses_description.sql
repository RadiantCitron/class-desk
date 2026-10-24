-- courses(강의 템플릿)에 "내용" 필드 추가.

alter table public.courses
  add column description text;
