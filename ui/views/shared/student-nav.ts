import type { NavItemView } from "./nav";

// 학생 메뉴의 정본. 페이지 본문에 이 3개 링크를 하드코딩하지 않는다(중복 → e2e 엄격 모드 위반, 부록 A G4).
export const STUDENT_NAV: readonly NavItemView[] = [
  { href: "/student", label: "내 수강" },
  { href: "/student/entitlements", label: "내 혜택" },
  { href: "/student/profile", label: "내 정보" },
];
