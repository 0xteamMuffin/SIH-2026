import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { validate } from "@scalar/openapi-parser";
import { apiRouteMounts, createApp, openApiDocument } from "../src/app.js";
import { usersRouter } from "../src/modules/users/users.routes.js";

const HTTP_METHODS = new Set(["delete", "get", "head", "options", "patch", "post", "put", "trace"]);

type RouteLayer = {
  route?: {
    path: string | string[];
    methods: Record<string, boolean>;
  };
};

function routerOperations(routeContainer: { stack: RouteLayer[] }, prefix = "") {
  return routeContainer.stack.flatMap((layer) => {
    if (!layer.route) return [];
    const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
    return paths.flatMap((path) => Object.entries(layer.route!.methods)
      .filter(([, enabled]) => enabled)
      .map(([method]) => `${method.toUpperCase()} ${`${prefix}${path}`.replace(/:([^/]+)/g, "{$1}").replace(/\/$/, "")}`));
  });
}

function documentedOperations() {
  return Object.entries(openApiDocument.paths).flatMap(([path, pathItem]) =>
    Object.keys(pathItem)
      .filter((method) => HTTP_METHODS.has(method))
      .map((method) => `${method.toUpperCase()} ${path}`));
}

describe("OpenAPI contract", () => {
  it("serves the versioned OpenAPI 3.1 document without authentication", async () => {
    const response = await request(createApp({ vectorStore: { isReady: vi.fn() } })).get("/openapi.json");

    expect(response.status).toBe(200);
    expect(response.type).toBe("application/json");
    expect(response.body).toEqual(openApiDocument);
    expect(response.body.openapi).toBe("3.1.0");
    expect(response.body.info.version).toBe("0.1.0");
  });

  it("is structurally valid OpenAPI 3.1", async () => {
    const result = await validate(JSON.stringify(openApiDocument));

    expect(result.errors, JSON.stringify(result.errors, null, 2)).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("represents every registered route and has no stale documented operations", () => {
    const application = createApp({ vectorStore: { isReady: vi.fn() } });
    const directOperations = routerOperations((application as unknown as { router: { stack: RouteLayer[] } }).router);
    const mountedOperations = apiRouteMounts.flatMap(({ prefix, router }) =>
      routerOperations(router as unknown as { stack: RouteLayer[] }, prefix));
    const nestedOperations = routerOperations(usersRouter as unknown as { stack: RouteLayer[] }, "/api/auth/users");

    expect(documentedOperations().sort()).toEqual([...directOperations, ...mountedOperations, ...nestedOperations].sort());
  });

  it("uses unique operation IDs and declares security for every operation", () => {
    const operations = Object.values(openApiDocument.paths).flatMap((pathItem) =>
      Object.entries(pathItem)
        .filter(([method]) => HTTP_METHODS.has(method))
        .map(([, operation]) => operation));
    const operationIds = operations.map((operation) => operation.operationId);

    expect(new Set(operationIds).size).toBe(operationIds.length);
    expect(operations.every((operation) => "security" in operation || openApiDocument.security.length > 0)).toBe(true);
  });
});
