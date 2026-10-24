// supabase-js는 generated Database 타입 없이는 belongs-to(자식→부모) 임베디드 관계도 항상
// 배열 타입으로 추론한다. 하지만 실제로 PostgREST는 FK 방향에 따라 이런 관계를 단일 객체로
// 반환한다(실측 확인, 2026-09-11 REST 호출로 직접 검증 — 의 기존 진단
// "관계형 select 결과가 배열로 추론되는 문제"는 원인 설명이 부정확했다: 런타임 데이터가 아니라
// TypeScript 타입 추론만 배열이었다). `?.[0]`로 우회하던 기존 관례는 사실 런타임에 항상
// undefined를 반환하는 조용한 버그였다 — 이 함수로 그 불일치를 한 곳에서만 흡수한다.
export function one<T>(relation: T | T[] | null | undefined): T | undefined {
  if (Array.isArray(relation)) return relation[0];
  return relation ?? undefined;
}
