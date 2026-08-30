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

const API_VERSION = "0.1.0";
const OPENAPI_VERSION = "3.1.0";
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const responseRef = (name: string) => ({ $ref: `#/components/responses/${name}` });
const parameterRef = (name: string) => ({ $ref: `#/components/parameters/${name}` });
const jsonResponse = (description: string, schema: object) => ({
  description,
  headers: { "X-Request-ID": { $ref: "#/components/headers/RequestId" } },
  content: { "application/json": { schema } },
});
const securedErrors = {
  "400": responseRef("BadRequest"),
  "401": responseRef("Unauthorized"),
  "403": responseRef("Forbidden"),
  "429": responseRef("RateLimited"),
  "500": responseRef("InternalError"),
};

export const openApiDocument = {
  openapi: OPENAPI_VERSION,
  jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
  info: {
    title: "Sovereign Industrial AI Workbench API",
    summary: "Backend API for authenticated industrial AI workbench operations.",
    description: "Create workspaces, manage artifacts and knowledge, execute agent runs, and review tool approvals. All protected operations use a JWT bearer token returned by the login operation.",
    version: API_VERSION,
    license: { name: "Proprietary" },
  },
  servers: [{ url: "/", description: "Current server" }],
  tags: [
    { name: "System", description: "Service health, readiness, and API contract metadata." },
    { name: "Authentication", description: "JWT authentication and current-user identity." },
    { name: "Workspaces", description: "Workspace discovery and creation." },
    { name: "Artifacts", description: "Workspace files, metadata, and downloads." },
    { name: "Runs", description: "Asynchronous agent execution and cancellation." },
    { name: "Approvals", description: "Human decisions for approval-gated agent tools." },
    { name: "Knowledge", description: "Indexed knowledge sources and asynchronous retrieval queries." },
  ],
  paths: {
    "/health": {
      get: {
        operationId: "getHealth",
        summary: "Get process health",
        tags: ["System"],
        security: [],
        responses: {
          "200": jsonResponse("The process is healthy.", ref("Health")),
          "500": responseRef("InternalError"),
        },
      },
    },
    "/ready": {
      get: {
        operationId: "getReadiness",
        summary: "Get dependency readiness",
        tags: ["System"],
        security: [],
        responses: {
          "200": jsonResponse("The service and required dependencies are ready.", ref("Readiness")),
          "503": jsonResponse("At least one required dependency is unavailable.", ref("Readiness")),
          "500": responseRef("InternalError"),
        },
      },
    },
    "/openapi.json": {
      get: {
        operationId: "getOpenApiDocument",
        summary: "Get the versioned OpenAPI contract",
        tags: ["System"],
        security: [],
        responses: {
          "200": jsonResponse("The OpenAPI 3.1 document for this API version.", ref("OpenApiDocument")),
          "500": responseRef("InternalError"),
        },
      },
    },
    "/api/auth/login": {
      post: {
        operationId: "login",
        summary: "Authenticate with email and password",
        tags: ["Authentication"],
        security: [],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                additionalProperties: false,
                required: ["email", "password"],
                properties: {
                  email: { type: "string", format: "email" },
                  password: { type: "string", minLength: 1, maxLength: 200, writeOnly: true },
                },
              },
            },
          },
        },
        responses: {
          "200": jsonResponse("Authentication succeeded.", {
            type: "object",
            additionalProperties: false,
            required: ["accessToken", "refreshToken", "expiresIn", "token", "user"],
            properties: {
              accessToken: { type: "string", description: "JWT access token." },
              refreshToken: { type: "string", description: "Opaque rotating refresh token." },
              expiresIn: { type: "integer", description: "Access-token lifetime in seconds." },
              token: { type: "string", description: "Compatibility alias for accessToken." },
              user: ref("User"),
            },
          }),
          "400": responseRef("BadRequest"),
          "401": responseRef("Unauthorized"),
          "403": responseRef("Forbidden"),
          "429": responseRef("RateLimited"),
          "500": responseRef("InternalError"),
        },
      },
    },
    "/api/auth/me": {
      get: {
        operationId: "getCurrentUser",
        summary: "Get the authenticated user",
        tags: ["Authentication"],
        responses: {
          "200": jsonResponse("Authenticated user identity.", {
            type: "object",
            additionalProperties: false,
            required: ["user"],
            properties: { user: ref("User") },
          }),
          ...securedErrors,
        },
      },
    },
    "/api/auth/refresh": {
      post: {
        operationId: "refreshSession",
        summary: "Rotate a refresh token",
        tags: ["Authentication"],
        security: [],
        requestBody: {
          required: true,
          content: { "application/json": { schema: ref("RefreshTokenRequest") } },
        },
        responses: {
          "200": jsonResponse("Session rotated and replacement tokens issued.", ref("Session")),
          "400": responseRef("BadRequest"),
          "401": responseRef("Unauthorized"),
          "429": responseRef("RateLimited"),
          "500": responseRef("InternalError"),
        },
      },
    },
    "/api/auth/logout": {
      post: {
        operationId: "logout",
        summary: "Revoke a refresh session",
        tags: ["Authentication"],
        security: [],
        requestBody: {
          required: true,
          content: { "application/json": { schema: ref("RefreshTokenRequest") } },
        },
        responses: {
          "204": { description: "Refresh session revoked.", headers: { "X-Request-ID": { $ref: "#/components/headers/RequestId" } } },
          "400": responseRef("BadRequest"),
          "429": responseRef("RateLimited"),
          "500": responseRef("InternalError"),
        },
      },
    },
    "/api/auth/revoke": {
      post: {
        operationId: "revokeAllSessions",
        summary: "Revoke all refresh sessions for the current user",
        tags: ["Authentication"],
        responses: {
          "204": { description: "All refresh sessions revoked.", headers: { "X-Request-ID": { $ref: "#/components/headers/RequestId" } } },
          ...securedErrors,
        },
      },
    },
    "/api/auth/users": {
      get: {
        operationId: "listUsers",
        summary: "List users",
        description: "Requires the global ADMIN role.",
        tags: ["Authentication"],
        responses: {
          "200": jsonResponse("Users ordered newest first.", {
            type: "object",
            additionalProperties: false,
            required: ["users"],
            properties: { users: { type: "array", items: ref("User") } },
          }),
          ...securedErrors,
        },
      },
      post: {
        operationId: "createUser",
        summary: "Create a user",
        description: "Requires the global ADMIN role.",
        tags: ["Authentication"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                additionalProperties: false,
                required: ["email", "password"],
                properties: {
                  email: { type: "string", format: "email" },
                  password: { type: "string", minLength: 12, maxLength: 200, writeOnly: true },
                  role: { ...ref("UserRole"), default: "OPERATOR" },
                },
              },
            },
          },
        },
        responses: {
          "201": jsonResponse("User created.", {
            type: "object",
            additionalProperties: false,
            required: ["user"],
            properties: { user: ref("User") },
          }),
          "409": responseRef("Conflict"),
          ...securedErrors,
        },
      },
    },
    "/api/auth/users/{userId}/disable": {
      post: {
        operationId: "disableUser",
        summary: "Disable a user",
        description: "Requires the global ADMIN role. Disabling a user revokes their active refresh sessions.",
        tags: ["Authentication"],
        parameters: [parameterRef("UserId")],
        responses: {
          "200": jsonResponse("User disabled, or returned unchanged if already disabled.", {
            type: "object",
            additionalProperties: false,
            required: ["user"],
            properties: { user: ref("User") },
          }),
          "404": responseRef("NotFound"),
          "409": responseRef("Conflict"),
          ...securedErrors,
        },
      },
    },
    "/api/workspaces": {
      get: {
        operationId: "listWorkspaces",
        summary: "List accessible workspaces",
        tags: ["Workspaces"],
        responses: {
          "200": jsonResponse("Accessible workspaces ordered newest first.", {
            type: "object",
            additionalProperties: false,
            required: ["workspaces"],
            properties: { workspaces: { type: "array", items: ref("Workspace") } },
          }),
          ...securedErrors,
        },
      },
      post: {
        operationId: "createWorkspace",
        summary: "Create a workspace",
        tags: ["Workspaces"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                additionalProperties: false,
                required: ["name"],
                properties: { name: { type: "string", minLength: 3, maxLength: 120 } },
              },
            },
          },
        },
        responses: {
          "201": jsonResponse("Workspace created.", {
            type: "object",
            additionalProperties: false,
            required: ["workspace"],
            properties: { workspace: ref("Workspace") },
          }),
          ...securedErrors,
        },
      },
    },
    "/api/workspaces/{workspaceId}/members": {
      parameters: [parameterRef("WorkspaceId")],
      get: {
        operationId: "listWorkspaceMembers",
        summary: "List workspace members",
        tags: ["Workspaces"],
        responses: {
          "200": jsonResponse("Workspace members with user summaries.", {
            type: "object",
            additionalProperties: false,
            required: ["members"],
            properties: { members: { type: "array", items: ref("WorkspaceMember") } },
          }),
          ...securedErrors,
        },
      },
      post: {
        operationId: "addWorkspaceMember",
        summary: "Add a workspace member",
        description: "Requires the workspace ADMIN role.",
        tags: ["Workspaces"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                additionalProperties: false,
                required: ["userId"],
                properties: {
                  userId: { type: "string", format: "uuid" },
                  role: { ...ref("UserRole"), default: "OPERATOR" },
                },
              },
            },
          },
        },
        responses: {
          "201": jsonResponse("Workspace member added.", {
            type: "object",
            additionalProperties: false,
            required: ["member"],
            properties: { member: ref("WorkspaceMember") },
          }),
          "404": responseRef("NotFound"),
          "409": responseRef("Conflict"),
          ...securedErrors,
        },
      },
    },
    "/api/workspaces/{workspaceId}/members/{userId}": {
      parameters: [parameterRef("WorkspaceId"), parameterRef("UserId")],
      patch: {
        operationId: "updateWorkspaceMember",
        summary: "Change a workspace member role",
        description: "Requires the workspace ADMIN role.",
        tags: ["Workspaces"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                additionalProperties: false,
                required: ["role"],
                properties: { role: ref("UserRole") },
              },
            },
          },
        },
        responses: {
          "200": jsonResponse("Workspace member role changed.", {
            type: "object",
            additionalProperties: false,
            required: ["member"],
            properties: { member: ref("WorkspaceMember") },
          }),
          "404": responseRef("NotFound"),
          "409": responseRef("Conflict"),
          ...securedErrors,
        },
      },
      delete: {
        operationId: "removeWorkspaceMember",
        summary: "Remove a workspace member",
        description: "Requires the workspace ADMIN role.",
        tags: ["Workspaces"],
        responses: {
          "204": { description: "Workspace member removed.", headers: { "X-Request-ID": { $ref: "#/components/headers/RequestId" } } },
          "404": responseRef("NotFound"),
          "409": responseRef("Conflict"),
          ...securedErrors,
        },
      },
    },
    "/api/workspaces/{workspaceId}/artifacts": {
      parameters: [parameterRef("WorkspaceId")],
      get: {
        operationId: "listArtifacts",
        summary: "List workspace artifacts",
        tags: ["Artifacts"],
        parameters: [
          parameterRef("Cursor"),
          parameterRef("Limit"),
          { name: "kind", in: "query", schema: ref("ArtifactKind") },
          { name: "extractionStatus", in: "query", schema: ref("ArtifactExtractionStatus") },
        ],
        responses: {
          "200": jsonResponse("A page of artifact metadata.", {
            type: "object",
            additionalProperties: false,
            required: ["artifacts", "pagination"],
            properties: {
              artifacts: { type: "array", items: ref("Artifact") },
              pagination: ref("Pagination"),
            },
          }),
          ...securedErrors,
        },
      },
      post: {
        operationId: "uploadArtifact",
        summary: "Upload a source artifact",
        description: "Accepts one file up to 25 MiB. The server validates supported file signatures before storing the artifact.",
        tags: ["Artifacts"],
        requestBody: {
          required: true,
          content: {
            "multipart/form-data": {
              schema: {
                type: "object",
                additionalProperties: false,
                required: ["file", "classification"],
                properties: {
                  file: { type: "string", format: "binary" },
                  classification: ref("DataClassification"),
                },
              },
            },
          },
        },
        responses: {
          "201": jsonResponse("Artifact uploaded.", {
            type: "object",
            additionalProperties: false,
            required: ["artifact"],
            properties: { artifact: ref("Artifact") },
          }),
          "413": responseRef("PayloadTooLarge"),
          "415": responseRef("UnsupportedMediaType"),
          ...securedErrors,
        },
      },
    },
    "/api/artifacts/{artifactId}": {
      get: {
        operationId: "getArtifact",
        summary: "Get artifact metadata",
        tags: ["Artifacts"],
        parameters: [parameterRef("ArtifactId")],
        responses: {
          "200": jsonResponse("Artifact metadata.", {
            type: "object",
            additionalProperties: false,
            required: ["artifact"],
            properties: { artifact: ref("Artifact") },
          }),
          "404": responseRef("NotFound"),
          ...securedErrors,
        },
      },
    },
    "/api/artifacts/{artifactId}/download": {
      get: {
        operationId: "downloadArtifact",
        summary: "Download artifact content",
        tags: ["Artifacts"],
        parameters: [parameterRef("ArtifactId")],
        responses: {
          "200": {
            description: "Artifact bytes. Content-Type and Content-Disposition reflect the stored artifact.",
            headers: {
              "X-Request-ID": { $ref: "#/components/headers/RequestId" },
              "Content-Disposition": { schema: { type: "string" } },
            },
            content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } },
          },
          "404": responseRef("NotFound"),
          ...securedErrors,
        },
      },
    },
    "/api/workspaces/{workspaceId}/runs": {
      post: {
        operationId: "createRun",
        summary: "Queue an agent run",
        tags: ["Runs"],
        parameters: [parameterRef("WorkspaceId")],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                additionalProperties: false,
                required: ["task", "dataClassification"],
                properties: {
                  task: { type: "string", minLength: 10, maxLength: 10000 },
                  artifactId: { type: "string", format: "uuid" },
                  dataClassification: ref("DataClassification"),
                },
              },
            },
          },
        },
        responses: {
          "202": jsonResponse("Agent run queued.", {
            type: "object",
            additionalProperties: false,
            required: ["run"],
            properties: { run: ref("AgentRun") },
          }),
          "422": responseRef("UnprocessableEntity"),
          ...securedErrors,
        },
      },
    },
    "/api/runs/{runId}": {
      get: {
        operationId: "getRun",
        summary: "Get an agent run",
        tags: ["Runs"],
        parameters: [parameterRef("RunId")],
        responses: {
          "200": jsonResponse("Agent run with messages, tool calls, approvals, model invocations, and evidence.", {
            type: "object",
            additionalProperties: false,
            required: ["run"],
            properties: { run: ref("AgentRun") },
          }),
          "404": responseRef("NotFound"),
          ...securedErrors,
        },
      },
    },
    "/api/runs/{runId}/cancel": {
      post: {
        operationId: "cancelRun",
        summary: "Cancel an active agent run",
        tags: ["Runs"],
        parameters: [parameterRef("RunId")],
        responses: {
          "200": jsonResponse("Agent run cancelled, or returned unchanged if already cancelled.", {
            type: "object",
            additionalProperties: false,
            required: ["run"],
            properties: { run: ref("AgentRun") },
          }),
          "404": responseRef("NotFound"),
          "409": responseRef("Conflict"),
          ...securedErrors,
        },
      },
    },
    "/api/agent-approvals/{approvalId}/decision": {
      post: {
        operationId: "decideToolApproval",
        summary: "Approve or reject an agent tool call",
        description: "The authenticated user must be an administrator or reviewer in the approval workspace.",
        tags: ["Approvals"],
        parameters: [parameterRef("ApprovalId")],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                additionalProperties: false,
                required: ["decision"],
                properties: {
                  decision: { type: "string", enum: ["APPROVED", "REJECTED"] },
                  note: { type: "string", minLength: 1, maxLength: 2000 },
                },
              },
            },
          },
        },
        responses: {
          "200": jsonResponse("Approval decision recorded and its run queued to resume.", {
            type: "object",
            additionalProperties: false,
            required: ["approval"],
            properties: { approval: ref("ToolApproval") },
          }),
          "404": responseRef("NotFound"),
          "409": responseRef("Conflict"),
          ...securedErrors,
        },
      },
    },
    "/api/workspaces/{workspaceId}/knowledge-sources": {
      parameters: [parameterRef("WorkspaceId")],
      get: {
        operationId: "listKnowledgeSources",
        summary: "List visible knowledge sources",
        tags: ["Knowledge"],
        parameters: [
          parameterRef("Cursor"),
          parameterRef("Limit"),
          { name: "visibility", in: "query", schema: ref("KnowledgeVisibility") },
          { name: "status", in: "query", schema: ref("KnowledgeSourceStatus") },
        ],
        responses: {
          "200": jsonResponse("A page of workspace-private and organization-shared knowledge sources.", {
            type: "object",
            additionalProperties: false,
            required: ["knowledgeSources", "pagination"],
            properties: {
              knowledgeSources: { type: "array", items: ref("KnowledgeSource") },
              pagination: ref("Pagination"),
            },
          }),
          ...securedErrors,
        },
      },
      post: {
        operationId: "createKnowledgeSource",
        summary: "Create and queue a knowledge source",
        description: "Requires ADMIN or OPERATOR. Organization-shared visibility additionally requires ADMIN.",
        tags: ["Knowledge"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                additionalProperties: false,
                required: ["artifactId"],
                properties: {
                  artifactId: { type: "string", format: "uuid" },
                  visibility: { ...ref("KnowledgeVisibility"), default: "WORKSPACE_PRIVATE" },
                },
              },
            },
          },
        },
        responses: {
          "202": jsonResponse("Knowledge source and indexing job created.", ref("KnowledgeSourceJobResult")),
          "409": responseRef("Conflict"),
          "503": responseRef("ServiceUnavailable"),
          ...securedErrors,
        },
      },
    },
    "/api/knowledge-sources/{sourceId}": {
      get: {
        operationId: "getKnowledgeSource",
        summary: "Get a knowledge source",
        tags: ["Knowledge"],
        parameters: [parameterRef("SourceId")],
        responses: {
          "200": jsonResponse("Knowledge source details.", {
            type: "object",
            additionalProperties: false,
            required: ["knowledgeSource"],
            properties: { knowledgeSource: ref("KnowledgeSource") },
          }),
          "404": responseRef("NotFound"),
          ...securedErrors,
        },
      },
    },
    "/api/knowledge-sources/{sourceId}/reindex": {
      post: {
        operationId: "reindexKnowledgeSource",
        summary: "Queue knowledge source reindexing",
        description: "Requires ADMIN or OPERATOR.",
        tags: ["Knowledge"],
        parameters: [parameterRef("SourceId")],
        responses: {
          "202": jsonResponse("Knowledge source revision and indexing job created.", ref("KnowledgeSourceJobResult")),
          "404": responseRef("NotFound"),
          "409": responseRef("Conflict"),
          "503": responseRef("ServiceUnavailable"),
          ...securedErrors,
        },
      },
    },
    "/api/workspaces/{workspaceId}/knowledge-queries": {
      post: {
        operationId: "createKnowledgeQuery",
        summary: "Queue a knowledge query",
        description: "Requires ADMIN or OPERATOR.",
        tags: ["Knowledge"],
        parameters: [parameterRef("WorkspaceId")],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                additionalProperties: false,
                required: ["queryText"],
                properties: {
                  queryText: { type: "string", minLength: 1, maxLength: 10000 },
                  topK: { type: "integer", minimum: 1, maximum: 100, default: 10 },
                  filters: ref("KnowledgeQueryFilters"),
                  dataClassification: { ...ref("DataClassification"), default: "INTERNAL" },
                },
              },
            },
          },
        },
        responses: {
          "202": jsonResponse("Knowledge query and execution job created.", ref("KnowledgeQueryJobResult")),
          "503": responseRef("ServiceUnavailable"),
          ...securedErrors,
        },
      },
    },
    "/api/knowledge-queries/{queryId}": {
      get: {
        operationId: "getKnowledgeQuery",
        summary: "Get a knowledge query",
        tags: ["Knowledge"],
        parameters: [parameterRef("QueryId")],
        responses: {
          "200": jsonResponse("Knowledge query status, result, index, and job details.", {
            type: "object",
            additionalProperties: false,
            required: ["knowledgeQuery"],
            properties: { knowledgeQuery: ref("KnowledgeQuery") },
          }),
          "404": responseRef("NotFound"),
          ...securedErrors,
        },
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
        description: "JWT returned by POST /api/auth/login.",
      },
    },
    headers: {
      RequestId: {
        description: "Request correlation UUID. A valid incoming X-Request-ID is preserved.",
        schema: { type: "string", format: "uuid" },
      },
    },
    parameters: {
      WorkspaceId: { name: "workspaceId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
      ArtifactId: { name: "artifactId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
      RunId: { name: "runId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
      ApprovalId: { name: "approvalId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
      UserId: { name: "userId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
      SourceId: { name: "sourceId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
      QueryId: { name: "queryId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
      Cursor: { name: "cursor", in: "query", description: "Opaque base64url pagination cursor.", schema: { type: "string", minLength: 1, maxLength: 512, pattern: "^[A-Za-z0-9_-]+$" } },
      Limit: { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 25 } },
    },
    responses: {
      BadRequest: jsonResponse("The request body, parameters, or JSON syntax are invalid.", ref("ErrorResponse")),
      Unauthorized: jsonResponse("Authentication is missing, invalid, or expired.", ref("ErrorResponse")),
      Forbidden: jsonResponse("The authenticated user lacks the required workspace access or role.", ref("ErrorResponse")),
      NotFound: jsonResponse("The requested resource or route was not found.", ref("ErrorResponse")),
      Conflict: jsonResponse("The requested state transition conflicts with current state.", ref("ErrorResponse")),
      PayloadTooLarge: jsonResponse("The request payload exceeds an accepted limit.", ref("ErrorResponse")),
      UnsupportedMediaType: jsonResponse("The supplied file or media type is unsupported.", ref("ErrorResponse")),
      UnprocessableEntity: jsonResponse("The request is valid but cannot be processed under current policy or limits.", ref("ErrorResponse")),
      RateLimited: {
        ...jsonResponse("The applicable request rate limit was exceeded.", ref("ErrorResponse")),
        headers: {
          "X-Request-ID": { $ref: "#/components/headers/RequestId" },
          "Retry-After": { schema: { type: "integer", minimum: 0 } },
        },
      },
      InternalError: jsonResponse("An unexpected server error occurred.", ref("ErrorResponse")),
      ServiceUnavailable: jsonResponse("A required dependency or active knowledge index is unavailable.", ref("ErrorResponse")),
    },
    schemas: {
      OpenApiDocument: {
        type: "object",
        additionalProperties: true,
        required: ["openapi", "info", "paths"],
        properties: {
          openapi: { type: "string", const: OPENAPI_VERSION },
          info: { type: "object" },
          paths: { type: "object" },
        },
      },
      Error: {
        type: "object",
        additionalProperties: false,
        required: ["code", "message"],
        properties: {
          code: { type: "string", examples: ["INVALID_INPUT"] },
          message: { type: "string", examples: ["Request validation failed"] },
        },
      },
      ErrorResponse: {
        type: "object",
        additionalProperties: false,
        required: ["error"],
        properties: { error: ref("Error") },
      },
      UserRole: { type: "string", enum: ["ADMIN", "OPERATOR", "REVIEWER"] },
      User: {
        type: "object",
        additionalProperties: false,
        required: ["id", "email", "role"],
        properties: {
          id: { type: "string", format: "uuid" },
          email: { type: "string", format: "email" },
          role: ref("UserRole"),
          disabledAt: { type: ["string", "null"], format: "date-time" },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
      },
      RefreshTokenRequest: {
        type: "object",
        additionalProperties: false,
        required: ["refreshToken"],
        properties: { refreshToken: { type: "string", minLength: 32, maxLength: 512, writeOnly: true } },
      },
      Session: {
        type: "object",
        additionalProperties: false,
        required: ["accessToken", "refreshToken", "expiresIn", "user"],
        properties: {
          accessToken: { type: "string" },
          refreshToken: { type: "string" },
          expiresIn: { type: "integer", minimum: 1 },
          user: ref("User"),
        },
      },
      Workspace: {
        type: "object",
        additionalProperties: true,
        required: ["id", "name", "createdBy", "createdAt"],
        properties: {
          id: { type: "string", format: "uuid" },
          name: { type: "string" },
          createdBy: { type: "string", format: "uuid" },
          createdAt: { type: "string", format: "date-time" },
        },
      },
      WorkspaceMember: {
        type: "object",
        additionalProperties: false,
        required: ["workspaceId", "userId", "role", "user"],
        properties: {
          workspaceId: { type: "string", format: "uuid" },
          userId: { type: "string", format: "uuid" },
          role: ref("UserRole"),
          user: ref("User"),
        },
      },
      DataClassification: { type: "string", enum: ["PUBLIC", "SYNTHETIC", "INTERNAL", "CONFIDENTIAL"] },
      ArtifactKind: { type: "string", enum: ["SOURCE", "GENERATED_DOCX", "CODE_OUTPUT"] },
      ArtifactExtractionStatus: { type: "string", enum: ["NOT_REQUIRED", "PENDING", "PROCESSING", "COMPLETED", "FAILED"] },
      Artifact: {
        type: "object",
        additionalProperties: true,
        required: ["id", "workspaceId", "createdBy", "kind", "classification", "extractionStatus", "filename", "mimeType", "sizeBytes", "createdAt"],
        properties: {
          id: { type: "string", format: "uuid" },
          workspaceId: { type: "string", format: "uuid" },
          createdBy: { type: "string", format: "uuid" },
          kind: ref("ArtifactKind"),
          classification: ref("DataClassification"),
          sha256: { type: ["string", "null"] },
          detectedMimeType: { type: ["string", "null"] },
          extractionStatus: ref("ArtifactExtractionStatus"),
          extractedObjectKey: { type: ["string", "null"] },
          extractionMetadata: {},
          extractionError: { type: ["string", "null"] },
          extractionStartedAt: { type: ["string", "null"], format: "date-time" },
          extractedAt: { type: ["string", "null"], format: "date-time" },
          filename: { type: "string" },
          mimeType: { type: "string" },
          objectKey: { type: "string" },
          sizeBytes: { oneOf: [{ type: "integer", minimum: 0 }, { type: "string", pattern: "^[0-9]+$" }] },
          createdAt: { type: "string", format: "date-time" },
        },
      },
      Pagination: {
        type: "object",
        additionalProperties: false,
        required: ["nextCursor"],
        properties: { nextCursor: { type: ["string", "null"] } },
      },
      Health: {
        type: "object",
        additionalProperties: false,
        required: ["status", "mode", "sovereign"],
        properties: {
          status: { type: "string", const: "ok" },
          mode: { type: "string" },
          sovereign: { type: "boolean" },
        },
      },
      Readiness: {
        type: "object",
        additionalProperties: false,
        required: ["status", "dependencies"],
        properties: {
          status: { type: "string", enum: ["ready", "not_ready"] },
          dependencies: {
            type: "object",
            additionalProperties: false,
            required: ["qdrant"],
            properties: { qdrant: { type: "string", enum: ["ready", "unavailable"] } },
          },
        },
      },
      RunStatus: { type: "string", enum: ["PENDING", "RUNNING", "WAITING_APPROVAL", "COMPLETED", "FAILED", "CANCELLED"] },
      RunToolCallStatus: { type: "string", enum: ["PENDING", "RUNNING", "WAITING_APPROVAL", "COMPLETED", "FAILED", "REJECTED", "CANCELLED"] },
      ApprovalStatus: { type: "string", enum: ["PENDING", "APPROVED", "REJECTED", "CANCELLED"] },
      ToolRiskLevel: { type: "string", enum: ["LOW", "MEDIUM", "HIGH"] },
      EvidenceKind: { type: "string", enum: ["SOURCE", "MODEL_OUTPUT"] },
      AgentRun: {
        type: "object",
        additionalProperties: true,
        required: ["id", "workspaceId", "requestedBy", "task", "taskCapability", "modelProfile", "modelReason", "dataClassification", "status", "state", "maxTurns", "maxToolCalls", "deadlineAt", "createdAt", "updatedAt"],
        properties: {
          id: { type: "string", format: "uuid" },
          workspaceId: { type: "string", format: "uuid" },
          requestedBy: { type: "string", format: "uuid" },
          task: { type: "string" },
          taskCapability: { type: "string" },
          modelProfile: { type: "string" },
          modelReason: { type: "string" },
          sourceArtifactId: { type: ["string", "null"], format: "uuid" },
          dataClassification: ref("DataClassification"),
          status: ref("RunStatus"),
          state: {},
          result: {},
          maxTurns: { type: "integer" },
          maxToolCalls: { type: "integer" },
          deadlineAt: { type: "string", format: "date-time" },
          activeWorkspaceId: { type: ["string", "null"], format: "uuid" },
          leaseId: { type: ["string", "null"], format: "uuid" },
          heartbeatAt: { type: ["string", "null"], format: "date-time" },
          leaseExpiresAt: { type: ["string", "null"], format: "date-time" },
          startedAt: { type: ["string", "null"], format: "date-time" },
          completedAt: { type: ["string", "null"], format: "date-time" },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
          messages: { type: "array", items: ref("RunMessage") },
          toolCalls: { type: "array", items: ref("RunToolCall") },
          approvals: { type: "array", items: ref("ToolApproval") },
          modelInvocations: { type: "array", items: ref("ModelInvocation") },
          evidence: { type: "array", items: ref("Evidence") },
        },
      },
      RunMessage: {
        type: "object",
        additionalProperties: true,
        required: ["id", "runId", "turn", "role", "content", "createdAt"],
        properties: {
          id: { type: "string", format: "uuid" }, runId: { type: "string", format: "uuid" }, turn: { type: "integer" },
          role: { type: "string" }, content: {}, createdAt: { type: "string", format: "date-time" },
        },
      },
      RunToolCall: {
        type: "object",
        additionalProperties: true,
        required: ["id", "runId", "modelToolCallId", "toolName", "input", "status", "riskLevel", "idempotencyKey", "startedAt"],
        properties: {
          id: { type: "string", format: "uuid" }, runId: { type: "string", format: "uuid" }, modelToolCallId: { type: "string" },
          toolName: { type: "string" }, input: {}, output: {}, status: ref("RunToolCallStatus"), riskLevel: ref("ToolRiskLevel"),
          idempotencyKey: { type: "string" }, startedAt: { type: "string", format: "date-time" },
          completedAt: { type: ["string", "null"], format: "date-time" },
        },
      },
      ToolApproval: {
        type: "object",
        additionalProperties: true,
        required: ["id", "runId", "toolCallId", "workspaceId", "toolName", "toolInput", "riskLevel", "status", "requestedAt"],
        properties: {
          id: { type: "string", format: "uuid" }, runId: { type: "string", format: "uuid" }, toolCallId: { type: "string", format: "uuid" },
          workspaceId: { type: "string", format: "uuid" }, toolName: { type: "string" }, toolInput: {}, riskLevel: ref("ToolRiskLevel"),
          status: ref("ApprovalStatus"), requestedAt: { type: "string", format: "date-time" }, decidedBy: { type: ["string", "null"], format: "uuid" },
          decisionNote: { type: ["string", "null"] }, decidedAt: { type: ["string", "null"], format: "date-time" },
        },
      },
      ModelInvocation: {
        type: "object",
        additionalProperties: true,
        required: ["id", "runId", "providerId", "profileId", "modelId", "attempt", "status", "startedAt"],
        properties: {
          id: { type: "string", format: "uuid" }, runId: { type: "string", format: "uuid" }, providerId: { type: "string" },
          profileId: { type: "string" }, modelId: { type: "string" }, attempt: { type: "integer" },
          status: { type: "string", enum: ["RUNNING", "SUCCEEDED", "FAILED", "CANCELLED"] }, latencyMs: { type: ["integer", "null"] },
          promptTokens: { type: ["integer", "null"] }, completionTokens: { type: ["integer", "null"] }, totalTokens: { type: ["integer", "null"] },
          finishReason: { type: ["string", "null"] }, sanitizedError: { type: ["string", "null"] },
          startedAt: { type: "string", format: "date-time" }, completedAt: { type: ["string", "null"], format: "date-time" },
        },
      },
      Evidence: {
        type: "object",
        additionalProperties: true,
        required: ["id", "runId", "sourceRef", "kind", "title", "summary", "facts", "createdAt"],
        properties: {
          id: { type: "string", format: "uuid" }, runId: { type: "string", format: "uuid" }, artifactId: { type: ["string", "null"], format: "uuid" },
          sourceRef: { type: "string" }, kind: ref("EvidenceKind"), title: { type: "string" }, summary: { type: "string" }, facts: {},
          createdAt: { type: "string", format: "date-time" },
        },
      },
      KnowledgeVisibility: { type: "string", enum: ["WORKSPACE_PRIVATE", "ORGANIZATION_SHARED"] },
      KnowledgeSourceStatus: { type: "string", enum: ["ACTIVE", "ARCHIVED", "DELETING", "DELETED"] },
      KnowledgeSourceIndexStatus: { type: "string", enum: ["PENDING", "INDEXING", "READY", "STALE", "REMOVING", "REMOVED", "FAILED"] },
      KnowledgeJobStatus: { type: "string", enum: ["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED"] },
      KnowledgeQueryStatus: { type: "string", enum: ["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED"] },
      KnowledgeSource: {
        type: "object",
        additionalProperties: true,
        required: ["id", "workspaceId", "artifactId", "createdBy", "visibility", "status", "revision", "createdAt", "updatedAt"],
        properties: {
          id: { type: "string", format: "uuid" }, workspaceId: { type: "string", format: "uuid" }, artifactId: { type: "string", format: "uuid" },
          createdBy: { type: "string", format: "uuid" }, visibility: ref("KnowledgeVisibility"), status: ref("KnowledgeSourceStatus"), revision: { type: "integer" },
          createdAt: { type: "string", format: "date-time" }, updatedAt: { type: "string", format: "date-time" },
          archivedAt: { type: ["string", "null"], format: "date-time" }, deletedAt: { type: ["string", "null"], format: "date-time" },
          artifact: ref("Artifact"), sourceIndexes: { type: "array", items: ref("KnowledgeSourceIndex") },
        },
      },
      KnowledgeSourceIndex: {
        type: "object",
        additionalProperties: true,
        required: ["id", "sourceId", "indexId", "sourceRevision", "indexRevision", "status", "chunkCount", "createdAt", "updatedAt"],
        properties: {
          id: { type: "string", format: "uuid" }, sourceId: { type: "string", format: "uuid" }, indexId: { type: "string", format: "uuid" },
          sourceRevision: { type: "integer" }, indexRevision: { type: "integer" }, status: ref("KnowledgeSourceIndexStatus"), chunkCount: { type: "integer" },
          sourceChecksum: { type: ["string", "null"] }, chunkSetChecksum: { type: ["string", "null"] }, lastError: { type: ["string", "null"] },
          indexedAt: { type: ["string", "null"], format: "date-time" }, createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" }, index: ref("KnowledgeIndex"),
        },
      },
      KnowledgeIndex: {
        type: "object",
        additionalProperties: true,
        required: ["id", "fingerprint", "collectionName", "vectorName", "profileId", "providerId", "modelId", "revision", "dimensions", "distance", "chunkerVersion", "status", "createdAt", "updatedAt"],
        properties: {
          id: { type: "string", format: "uuid" }, fingerprint: { type: "string" }, collectionName: { type: "string" }, vectorName: { type: "string" },
          profileId: { type: "string" }, providerId: { type: "string" }, modelId: { type: "string" }, revision: { type: "integer" }, dimensions: { type: "integer" },
          distance: { type: "string", enum: ["COSINE", "EUCLID", "DOT", "MANHATTAN"] }, chunkerVersion: { type: "string" },
          status: { type: "string", enum: ["PROVISIONING", "ACTIVE", "RETIRING", "RETIRED", "DELETING", "DELETED", "FAILED"] },
          createdAt: { type: "string", format: "date-time" }, updatedAt: { type: "string", format: "date-time" },
          activatedAt: { type: ["string", "null"], format: "date-time" }, retiredAt: { type: ["string", "null"], format: "date-time" },
        },
      },
      KnowledgeJob: {
        type: "object",
        additionalProperties: true,
        required: ["id", "indexId", "type", "status", "attempts", "maxAttempts", "availableAt", "createdAt", "updatedAt"],
        properties: {
          id: { type: "string", format: "uuid" }, workspaceId: { type: ["string", "null"], format: "uuid" }, indexId: { type: "string", format: "uuid" },
          sourceIndexId: { type: ["string", "null"], format: "uuid" }, queryId: { type: ["string", "null"], format: "uuid" },
          type: { type: "string", enum: ["INDEX_SOURCE", "REMOVE_SOURCE", "REBUILD_INDEX", "EXECUTE_QUERY", "RECONCILE_INDEX"] },
          status: ref("KnowledgeJobStatus"), attempts: { type: "integer" }, maxAttempts: { type: "integer" }, availableAt: { type: "string", format: "date-time" },
          lastError: { type: ["string", "null"] }, startedAt: { type: ["string", "null"], format: "date-time" }, completedAt: { type: ["string", "null"], format: "date-time" },
          createdAt: { type: "string", format: "date-time" }, updatedAt: { type: "string", format: "date-time" },
        },
      },
      KnowledgeQueryFilters: {
        type: "object",
        additionalProperties: false,
        properties: {
          artifactIds: { type: "array", minItems: 1, maxItems: 100, items: { type: "string", format: "uuid" } },
          classifications: { type: "array", minItems: 1, maxItems: 4, items: ref("DataClassification") },
          scoreThreshold: { type: "number" },
        },
        default: {},
      },
      KnowledgeQuery: {
        type: "object",
        additionalProperties: true,
        required: ["id", "workspaceId", "requestedBy", "indexId", "indexRevision", "dataClassification", "status", "queryText", "topK", "filters", "createdAt", "updatedAt"],
        properties: {
          id: { type: "string", format: "uuid" }, workspaceId: { type: "string", format: "uuid" }, requestedBy: { type: "string", format: "uuid" },
          indexId: { type: "string", format: "uuid" }, indexRevision: { type: "integer" }, dataClassification: ref("DataClassification"), status: ref("KnowledgeQueryStatus"),
          queryText: { type: "string" }, topK: { type: "integer" }, filters: ref("KnowledgeQueryFilters"), result: {}, lastError: { type: ["string", "null"] },
          startedAt: { type: ["string", "null"], format: "date-time" }, completedAt: { type: ["string", "null"], format: "date-time" },
          createdAt: { type: "string", format: "date-time" }, updatedAt: { type: "string", format: "date-time" }, index: ref("KnowledgeIndex"), job: ref("KnowledgeJob"),
        },
      },
      KnowledgeSourceJobResult: {
        type: "object",
        additionalProperties: false,
        required: ["knowledgeSource", "job"],
        properties: { knowledgeSource: ref("KnowledgeSource"), job: ref("KnowledgeJob") },
      },
      KnowledgeQueryJobResult: {
        type: "object",
        additionalProperties: false,
        required: ["knowledgeQuery", "job"],
        properties: { knowledgeQuery: ref("KnowledgeQuery"), job: ref("KnowledgeJob") },
      },
    },
  },
  security: [{ bearerAuth: [] }],
};

const defaultDependencies = {
  vectorStore: { isReady: () => getQdrantVectorStore().isReady() },
};

export const apiRouteMounts = [
  { prefix: "/api/auth", router: authRouter },
  { prefix: "/api/workspaces", router: workspacesRouter },
  { prefix: "/api", router: artifactsRouter },
  { prefix: "/api", router: agentRouter },
  { prefix: "/api", router: knowledgeRouter },
] as const;

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
  application.get("/openapi.json", (_request, response) => response.json(openApiDocument));
  mountApiRateLimits(application);
  for (const { prefix, router } of apiRouteMounts) application.use(prefix, router);
  application.use(notFoundHandler);
  application.use(errorHandler);
  return application;
}

export const app = createApp();
