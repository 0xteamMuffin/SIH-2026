import { describe, expect, it } from "vitest";
import { toolDefinition, toolDefinitions } from "../src/modules/agent/agent-tool-definitions.js";
import { agentToolRegistry, type AgentToolName } from "../src/modules/agent/agent-tool-registry.js";

const allToolNames = Object.keys(agentToolRegistry) as AgentToolName[];

describe("toolDefinitions", () => {
  it("exposes every registered tool by default", () => {
    expect(toolDefinitions().map((tool) => tool.name).sort()).toEqual([...allToolNames].sort());
  });

  it("exposes only the requested subset", () => {
    const definitions = toolDefinitions(["knowledge.search", "artifact.read"]);

    expect(definitions.map((tool) => tool.name)).toEqual(["knowledge.search", "artifact.read"]);
  });

  it("gives every tool a description substantial enough to route on", () => {
    for (const definition of toolDefinitions()) {
      expect(definition.description.length, definition.name).toBeGreaterThan(40);
    }
  });

  it("emits an object schema for every tool", () => {
    for (const definition of toolDefinitions()) {
      expect(definition.parameters["type"], definition.name).toBe("object");
      expect(definition.parameters["properties"], definition.name).toBeTypeOf("object");
    }
  });

  it("strips $schema, which some providers reject", () => {
    for (const definition of toolDefinitions()) {
      expect(definition.parameters).not.toHaveProperty("$schema");
    }
  });

  it("inlines schemas rather than emitting $ref", () => {
    for (const definition of toolDefinitions()) {
      expect(JSON.stringify(definition.parameters), definition.name).not.toContain("$ref");
    }
  });

  it("carries field descriptions through to the schema", () => {
    const search = toolDefinition("knowledge.search");
    const properties = search.parameters["properties"] as Record<string, { description?: string }>;

    expect(properties["query"]?.description).toBeTruthy();
  });

  it("marks required fields so the model cannot omit them", () => {
    const read = toolDefinition("artifact.read");

    expect(read.parameters["required"]).toEqual(expect.arrayContaining(["artifactId", "extractionVersion"]));
  });

  it("preserves enum constraints from the source schema", () => {
    const sandbox = toolDefinition("sandbox.execute");
    const properties = sandbox.parameters["properties"] as Record<string, { enum?: string[] }>;

    expect(properties["language"]?.enum).toEqual(["javascript", "python"]);
  });

  it("returns a stable cached definition per tool", () => {
    expect(toolDefinition("knowledge.search")).toBe(toolDefinition("knowledge.search"));
  });
});
