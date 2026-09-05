import { zodToJsonSchema } from "zod-to-json-schema";
import type { ToolDefinition } from "../../infrastructure/models/model-provider.js";
import { agentToolRegistry, type AgentToolName } from "./agent-tool-registry.js";

/**
 * Projects the tool registry into the JSON Schema shape providers expect.
 *
 * Derived from the same Zod schemas that validate the model's arguments on the
 * way back in, so what the model is told and what is enforced cannot drift.
 */

const cache = new Map<AgentToolName, ToolDefinition>();

function buildDefinition(name: AgentToolName): ToolDefinition {
  const tool = agentToolRegistry[name];
  const schema = zodToJsonSchema(tool.input, {
    // Providers vary in how well they resolve `$ref`, and these schemas are
    // small, so everything is inlined.
    $refStrategy: "none",
    target: "jsonSchema7",
  }) as Record<string, unknown>;

  // `$schema` is metadata that some providers reject outright.
  delete schema["$schema"];

  return { name, description: tool.description, parameters: schema };
}

export function toolDefinition(name: AgentToolName): ToolDefinition {
  const cached = cache.get(name);
  if (cached) return cached;

  const definition = buildDefinition(name);
  cache.set(name, definition);
  return definition;
}

/**
 * Definitions for the named tools, or for every registered tool.
 *
 * Callers pass a subset when a run should not be offered a capability — a
 * workspace with no knowledge index has no use for `knowledge.search`, and
 * offering a tool that always fails wastes turns and teaches the model to
 * distrust its own tools.
 */
export function toolDefinitions(names?: readonly AgentToolName[]): ToolDefinition[] {
  const selected = names ?? (Object.keys(agentToolRegistry) as AgentToolName[]);
  return selected.map(toolDefinition);
}
