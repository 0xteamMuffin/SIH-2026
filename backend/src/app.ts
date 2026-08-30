import express from "express";
import { errorHandler, notFoundHandler } from "./lib/errors.js";
import { authRouter } from "./modules/auth/auth.routes.js";
import { workspacesRouter } from "./modules/workspaces/workspaces.routes.js";
import { artifactsRouter } from "./modules/artifacts/artifacts.routes.js";
import { agentRouter } from "./modules/agent/agent.routes.js";
import { knowledgeRouter } from "./modules/knowledge/knowledge.routes.js";
import { env } from "./config/env.js";
import { getQdrantVectorStore } from "./infrastructure/vector-store/qdrant-vector-store.js";
import type { VectorStoreAdmin } from "./infrastructure/vector-store/vector-store-admin.js";
import { mountApiRateLimits, mountRequestHardening } from "./middleware/request-hardening.js";

const defaultDependencies = {
  vectorStore: { isReady: () => getQdrantVectorStore().isReady() },
};

export function createApp(dependencies: { vectorStore: Pick<VectorStoreAdmin, "isReady"> } = defaultDependencies) {
  const application = express();
  mountRequestHardening(application);
  application.get("/health", (_request, response) => response.json({ status: "ok", mode: env.APP_MODE, sovereign: env.APP_MODE === "sovereign" }));
  application.get("/ready", async (_request, response) => {
    let qdrantReady = false;
    try {
      qdrantReady = await dependencies.vectorStore.isReady();
    } catch {
      // Dependency failures make the process unready, not unhealthy.
    }
    response.status(qdrantReady ? 200 : 503).json({
      status: qdrantReady ? "ready" : "not_ready",
      dependencies: { qdrant: qdrantReady ? "ready" : "unavailable" },
    });
  });
  mountApiRateLimits(application);
  application.use("/api/auth", authRouter); application.use("/api/workspaces", workspacesRouter); application.use("/api", artifactsRouter); application.use("/api", agentRouter); application.use("/api", knowledgeRouter);
  application.use(notFoundHandler);
  application.use(errorHandler);
  return application;
}

export const app = createApp();
