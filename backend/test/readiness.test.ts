import { describe, expect, it, vi } from "vitest";
import { checkReadiness, type DependencyName, type ReadinessCheck } from "../src/modules/observability/readiness.js";

function checks(overrides: Partial<Record<DependencyName, ReadinessCheck>> = {}): Record<DependencyName, ReadinessCheck> {
  const ready = vi.fn().mockResolvedValue(true);
  return {
    postgresql: ready,
    minio: ready,
    rabbitmq: ready,
    qdrant: ready,
    sandbox: ready,
    docling: ready,
    ...overrides,
  };
}

describe("dependency readiness", () => {
  it("runs checks in parallel and bounds slow dependencies", async () => {
    const never = vi.fn((_signal: AbortSignal) => new Promise<boolean>(() => undefined));
    const startedAt = performance.now();
    const result = await checkReadiness(checks({ rabbitmq: never, sandbox: never }), { timeoutMs: 25 });

    expect(performance.now() - startedAt).toBeLessThan(150);
    expect(result.status).toBe("not_ready");
    expect(result.dependencies.rabbitmq).toBe("unavailable");
    expect(result.dependencies.sandbox).toBe("unavailable");
  });

  it("reports optional Docling without blocking general readiness", async () => {
    const result = await checkReadiness(checks({ docling: vi.fn().mockResolvedValue(false) }), { timeoutMs: 100, doclingRequired: false });

    expect(result.status).toBe("ready");
    expect(result.dependencies.docling).toBe("optional_unavailable");
  });

  it("blocks readiness when Docling is configured as required", async () => {
    const result = await checkReadiness(checks({ docling: vi.fn().mockRejectedValue(new Error("offline")) }), { timeoutMs: 100, doclingRequired: true });

    expect(result.status).toBe("not_ready");
    expect(result.dependencies.docling).toBe("unavailable");
  });
});
