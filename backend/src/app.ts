import express from "express";
import cors from "cors";
import helmet from "helmet";
import { logger } from "./lib/logger.js";
import { errorHandler, notFoundHandler } from "./lib/errors.js";
import { authRouter } from "./modules/auth/auth.routes.js";
import { workspacesRouter } from "./modules/workspaces/workspaces.routes.js";
import { artifactsRouter } from "./modules/artifacts/artifacts.routes.js";
import { agentRouter } from "./modules/agent/agent.routes.js";
import { env } from "./config/env.js";
import { getQdrantVectorStore } from "./infrastructure/vector-store/qdrant-vector-store.js";
import type { VectorStoreAdmin } from "./infrastructure/vector-store/vector-store-admin.js";

const defaultDependencies = {
  vectorStore: { isReady: () => getQdrantVectorStore().isReady() },
};

export function createApp(dependencies: { vectorStore: Pick<VectorStoreAdmin, "isReady"> } = defaultDependencies) {
  const application = express();
  application.use(helmet()); application.use(cors({ origin: true, credentials: false })); application.use(express.json({ limit: "2mb" }));
  application.get("/health", (_request, response) => response.json({ status: "ok", mode: env.APP_MODE, sovereign: env.APP_MODE === "sovereign" }));
  application.get("/ready", async (_request, response) => {
    const qdrantReady = await dependencies.vectorStore.isReady();
    response.status(qdrantReady ? 200 : 503).json({
      status: qdrantReady ? "ready" : "not_ready",
      dependencies: { qdrant: qdrantReady ? "ready" : "unavailable" },
    });
  });
  application.use("/api/auth", authRouter); application.use("/api/workspaces", workspacesRouter); application.use("/api", artifactsRouter); application.use("/api", agentRouter);
  application.use(notFoundHandler);
  application.use(errorHandler);
  return application;
}

export const app = createApp();
