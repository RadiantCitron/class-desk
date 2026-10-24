-- 가입 약관(SERVICE_USE)에 디스코드 이메일 인증 조항을 명시한다(2026-09-15 수정하기로 한 것 C).
-- 기존 SERVICE_TERMS_v1은 append-only라 고치지 않고 새 버전만 추가한다.
-- getCurrentTerms()는 effective_at 최신을 쓰므로, 이후 신규 가입은 /terms에서 이 본문을 본다.

insert into public.terms (type, version, content) values
  (
    'SERVICE_USE',
    'SERVICE_TERMS_v2',
    '본 서비스 이용 및 계정 식별 목적으로 디스코드 ID, 이메일을 수집합니다. 수집한 정보는 수강 신청·결제·환불 이력 관리 목적으로만 사용됩니다.

가입은 디스코드에서 이메일 인증이 완료된 계정만 할 수 있습니다. 가입 후 디스코드에서 이메일을 변경한 경우, 새 주소도 인증되어야 합니다. 인증되지 않은 상태에서는 조회만 가능하며 신청·결제·다운로드는 할 수 없습니다.

탈퇴 시 사이트 접속 및 수강 페이지 접근이 즉시 제한되며, 수강 및 결제 분쟁 대응을 위해 신청 기록은 탈퇴일로부터 3년간 보관 후 파기됩니다.

※ 이 문구는 placeholder입니다. 실제 서비스 오픈 전 전문으로 교체해야 합니다.'
  )
on conflict (type, version) do nothing;
