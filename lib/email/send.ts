import nodemailer from "nodemailer";

// 이메일도 결제(mock PG)와 같은 원칙 — 흉내만 낸다. 로컬 개발에서는
// 로컬 Supabase에 이미 번들된 Mailpit(SMTP 캐처)으로 보낸다: 실제로 발송되지 않고
// http://127.0.0.1:54324 에서 "보낸 메일"을 확인할 수 있다. 실 서비스로 전환할 때는
// SMTP_HOST/PORT/USER/PASS 환경변수만 진짜 SMTP 서버로 바꾸면 된다 — 코드 변경 불필요.
export async function sendEmail(params: { to: string; subject: string; text: string }) {
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST ?? "127.0.0.1",
    port: Number(process.env.SMTP_PORT ?? 54325),
    secure: false,
    ignoreTLS: !process.env.SMTP_HOST, // 로컬 Mailpit은 TLS가 없다.
    auth:
      process.env.SMTP_USER && process.env.SMTP_PASS
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
  });

  await transport.sendMail({
    from: process.env.SMTP_FROM ?? "class-desk@localhost",
    to: params.to,
    subject: params.subject,
    text: params.text,
  });
}
