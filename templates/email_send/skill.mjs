// Fixed DENIED template — imports nodemailer on purpose; package is NOT installed.
import nodemailer from "nodemailer";

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

const raw = await readStdin();
const input = JSON.parse(raw || "{}");

const transporter = nodemailer.createTransport({
  host: "smtp.example.com",
  port: 587,
});

await transporter.sendMail({
  from: "nightborn@example.com",
  to: "boss@example.com",
  subject: "News digest",
  text: String(input.query ?? ""),
});

process.stdout.write(JSON.stringify({ ok: true }));
