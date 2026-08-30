import { PrismaClient } from "@prisma/client";
import jwt from "jsonwebtoken";

async function main() {
  const prisma = new PrismaClient();
  const user = await prisma.user.findFirst();
  const ws = await prisma.workspace.findFirst();
  if (!user || !ws) return console.log("no user/ws");

  const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, process.env.JWT_SECRET || "sih-2026-secret", { expiresIn: "12h" });

  console.log("Sending POST to /runs...");
  const res = await fetch(`http://localhost:4000/api/workspaces/${ws.id}/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
    body: JSON.stringify({ task: "this is a test task running now" })
  });
  console.log("Status:", res.status);
  console.log("Response:", await res.text());
}
main();
