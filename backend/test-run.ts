import { PrismaClient } from "@prisma/client";
import { createRun } from "./src/modules/agent/agent.service.js";
const prisma = new PrismaClient();
async function main() {
  const ws = await prisma.workspace.findFirst();
  const user = await prisma.user.findFirst();
  if (!ws || !user) throw new Error("No ws or user");
  console.log("Creating run...");
  const run = await createRun({ workspaceId: ws.id, userId: user.id, task: "This is a test task for debugging" });
  console.log("Run created successfully!", run.id);
  // Wait a few seconds for processRun to finish
  await new Promise(r => setTimeout(r, 4000));
  const finished = await prisma.agentRun.findUnique({ where: { id: run.id }, include: { toolCalls: true, messages: true } });
  console.log("Finished state:", finished?.status, finished?.result);
}
main().catch(console.error).finally(() => prisma.$disconnect());
