-- -3(2026-09-26). DLQ 항목을 "해결"로 표시할 때 사유를 남긴다
-- (app/admin/students/actions.ts의 setStudentRestriction과 같은 패턴). 기존 행은 NULL로 둔다
-- (append-only 원칙 — 과거 이력을 소급해서 채우지 않는다).
alter table public.dead_letters add column resolution_reason text;
