import express from "express";
import cors from "cors";
import helmet from "helmet";
import { logger } from "./lib/logger.js";
import { errorHandler } from "./lib/errors.js";
import { authRouter } from "./modules/auth/auth.routes.js";
import { workspacesRouter } from "./modules/workspaces/workspaces.routes.js";
import { artifactsRouter } from "./modules/artifacts/artifacts.routes.js";
import { agentRouter } from "./modules/agent/agent.routes.js";
import { env } from "./config/env.js";

export const app = express();
app.use(helmet()); app.use(cors({ origin: true, credentials: false })); app.use(express.json({ limit: "2mb" }));
app.get("/health", (_request, response) => response.json({ status: "ok", mode: env.APP_MODE, sovereign: env.APP_MODE === "sovereign" }));
app.use("/api/auth", authRouter); app.use("/api/workspaces", workspacesRouter); app.use("/api", artifactsRouter); app.use("/api", agentRouter);
app.use(errorHandler);
