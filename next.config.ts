import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Next 16는 기본적으로 localhost만 개발 리소스(/_next)를 연다. 아래 리다이렉트로
  // 127.0.0.1에서 열면 버튼 JS가 안 내려와서 클릭해도 반응이 없다(2026-09-15).
  allowedDevOrigins: ["127.0.0.1"],
  // site_url·쿠키는 127.0.0.1 기준이다. localhost로 열면 PKCE가 다른 주소에 저장되어
  // 콜백이 auth_failed가 된다(2026-09-15). 로그인 전에 주소를 맞춘다.
  async redirects() {
    return [
      {
        source: "/:path*",
        has: [{ type: "host", value: "localhost" }],
        // RSC 페이로드 요청(rsc 헤더)과 서버 액션 호출(next-action 헤더)에는 이 규칙을
        // 적용하지 않는다. Next 16은 서버 액션의 redirect() 목적지를 서버 내부 요청으로
        // 다시 렌더링하는데, 그 요청의 Host가 localhost라 이 규칙에 걸리면 127.0.0.1로
        // 리다이렉트되고, 쿠키는 127.0.0.1 스코프라 그 요청에 실려 가지 못한다. 그러면
        // proxy.ts가 비로그인으로 판정해 /login으로 보내고, 브라우저는 신청·결제가 성공했는데도
        // 로그인 화면을 보게 된다(2026-09-20 규명. e2e apply/payment/full-scenario 4개가
        // 이것 때문에 실패하고 있었다). 사람이 주소창에 localhost를 치는 경우(문서 내비게이션,
        // 이 두 헤더가 없음)는 그대로 보호된다.
        missing: [
          { type: "header", key: "rsc" },
          { type: "header", key: "next-action" },
        ],
        destination: "http://127.0.0.1:3000/:path*",
        permanent: false,
      },
    ];
  },
};

export default nextConfig;
