// 클라우드 연결 개발 서버: next dev를 클라우드 Supabase(link한 프로젝트)에 붙여 띄운다.
// - .env.local은 고치지 않는다. 키는 실행할 때마다 Supabase CLI로 받아 이 프로세스의 환경변수로만 넣는다
//   (Next는 이미 설정된 환경변수를 .env.local로 덮어쓰지 않는다 — tools/dev-fake.mjs와 같은 원리).
// - 키·프로젝트 ID는 화면에 출력하지 않는다(길이만). 이 파일에도 비밀값이 없다.
// - ALLOW_TEST_LOGIN을 빈 값으로 덮어 /api/test/login을 닫는다.
// 준비: 별도 터미널에서 `npx supabase login` → `npx supabase link` 필요.
// 상세: .env.local.example 참고.
import { execSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";

const root = process.cwd();

function fail(message) {
  console.error(`[dev:cloud] ${message}`);
  process.exit(1);
}

function cli(args) {
  try {
    const raw = execSync(`npx supabase ${args}`, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return JSON.parse(raw.slice(raw.indexOf("[")));
  } catch {
    fail(`'npx supabase ${args.split(" ")[0]} …' 실패 — 별도 PowerShell 창에서 'npx supabase login'을 했는지 확인하세요.`);
  }
}

// 3000 포트가 이미 쓰이면 Next가 다른 포트로 뜬다. 메일 링크(Site URL)는 127.0.0.1:3000 기준이라 멈춘다.
function portInUse(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

const refPath = join(root, "supabase", ".temp", "project-ref");
if (!existsSync(refPath)) {
  fail("이 PC가 클라우드 프로젝트에 link되어 있지 않습니다. 별도 PowerShell 창에서 'npx supabase link'를 먼저 하세요.");
}
const ref = readFileSync(refPath, "utf8").trim();

const project = cli("projects list -o json").find((p) => p.id === ref);
if (!project) fail("link된 프로젝트를 계정의 프로젝트 목록에서 찾지 못했습니다. 'npx supabase link'를 다시 하세요.");

const keys = cli(`projects api-keys --project-ref ${ref} -o json`);
const pick = (name) => keys.find((k) => k.name === name && k.type === "legacy")?.api_key;
const anon = pick("anon");
const service = pick("service_role");
if (!anon || !service) fail("클라우드 anon·service_role 키를 받지 못했습니다. 중단합니다.");

if (await portInUse(3000)) {
  fail("3000 포트를 이미 쓰고 있습니다. 켜져 있는 개발 서버(npm run dev 등)를 먼저 끄세요.");
}

console.log(
  [
    "",
    "================================================================",
    `  ⚠ 클라우드 연결 모드 — 프로젝트 「${project.name}」의 실제 DB를 씁니다.`,
    "  이 서버가 켜져 있는 동안 하지 말 것:",
    "    - npm run e2e / npx playwright test / npm run test:integration",
    "      (테스트가 연결된 DB의 행을 지우고 고친다)",
    "    - --linked가 붙은 supabase 명령(특히 db reset --linked = 클라우드 DB 삭제)",
    "  여기서 가입·결제하면 클라우드에 그대로 남습니다.",
    "  끄기: Ctrl+C. 끄면 연결도 끝나고 .env.local은 처음부터 그대로입니다.",
    "================================================================",
    `[dev:cloud] url=https://<ref ${ref.length}자>.supabase.co, anon ${anon.length}자, service_role ${service.length}자, ALLOW_TEST_LOGIN=""`,
    "[dev:cloud] 브라우저 주소: http://127.0.0.1:3000",
    "",
  ].join("\n"),
);

const next = spawn(process.execPath, [join("node_modules", "next", "dist", "bin", "next"), "dev"], {
  cwd: root,
  env: {
    ...process.env,
    NEXT_PUBLIC_SUPABASE_URL: `https://${ref}.supabase.co`,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: anon,
    SUPABASE_SERVICE_ROLE_KEY: service,
    ALLOW_TEST_LOGIN: "",
  },
  stdio: "inherit",
});
next.on("exit", (code) => process.exit(code ?? 0));
process.on("SIGINT", () => next.kill());
process.on("SIGTERM", () => next.kill());
