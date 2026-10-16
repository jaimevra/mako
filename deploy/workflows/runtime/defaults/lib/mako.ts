// Mako access for workflow code: Mako's agent, models, Mako's tools, and SQL.
// Credentials come from the worker's environment; nothing is hardcoded.
import { createGateway } from "@ai-sdk/gateway";
import { createMCPClient } from "@ai-sdk/mcp";

const url = process.env.MAKO_URL ?? "http://localhost:8080";
const key = process.env.MAKO_API_KEY ?? "";

/**
 * Mako's own agent: give it a goal, it works with Mako's tools and skills and
 * answers. `toolCalls` names what it used, in order; `chatId` is the run,
 * kept in Mako. Counted in the workspace's usage.
 */
export async function agent(
  goal: string,
  options: { model?: string; maxSteps?: number } = {},
): Promise<{ text: string; toolCalls: string[]; chatId: string }> {
  const workflow = workflowName();
  const res = await fetch(`${url}/api/workflows/runtime/agent`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(workflow ? { "X-Mako-Workflow": workflow } : {}),
    },
    body: JSON.stringify({ goal, ...options }),
  });
  const body = (await res.json()) as {
    text: string;
    toolCalls: string[];
    chatId: string;
    error?: string;
  };
  if (!res.ok)
    throw new Error(body.error ?? `The agent failed (${res.status})`);
  return body;
}

/** A model, e.g. `model("anthropic/claude-sonnet-4.5")`. Counted in the workspace's usage. */
export const model = createGateway({
  baseURL: `${url}/api/workflows/runtime/ai`,
  apiKey: key,
});

/** What a decision model judges: text, or JSON it reads as data. */
export type DecisionState =
  | string
  | ({ type: "text"; text: string } | { type: "json"; value: unknown })[];

/** One judgement about the state. Criteria describe the options (null: none). */
export type DecisionQuestion =
  | {
      type: "choice";
      instructions: string;
      criteria: Record<string, string | null>;
    }
  | { type: "score"; instructions: string; criteria: (string | null)[] }
  | {
      type: "boolean";
      instructions: string;
      criteria?: { true?: string | null; false?: string | null };
    };

export type DecisionAnswer =
  | { type: "choice"; choice: string; probabilities?: Record<string, number> }
  | { type: "score"; score: number; probabilities?: Record<string, number> }
  | { type: "boolean"; probability: number }
  | { type: "refusal" };

/**
 * A decision model (e.g. Jev) answering several questions about one state,
 * with probabilities rather than text. Counted in the workspace's usage.
 *
 * `decide({ model: "...", state: ticket, questions: { category: { type:
 * "choice", instructions: "...", criteria: { bug: null, billing: null } } } })`
 */
export async function decide<
  Q extends Record<string, DecisionQuestion>,
>(options: {
  model: string;
  state: DecisionState;
  questions: Q;
}): Promise<{ answers: { [K in keyof Q]: DecisionAnswer }; model?: string }> {
  const stateParts =
    typeof options.state === "string"
      ? [{ type: "text", text: options.state }]
      : options.state;
  const res = await fetch(`${url}/api/workflows/runtime/ai/decision-model`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "ai-decision-model-specification-version": "4",
      "ai-model-id": options.model,
    },
    body: JSON.stringify({ stateParts, questions: options.questions }),
  });
  const text = await res.text();
  let body: {
    answers?: { [K in keyof Q]: DecisionAnswer };
    model?: string;
    error?: string | { message?: string };
  } = {};
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON: the status says what went wrong.
  }
  if (!res.ok || !body.answers) {
    const error =
      typeof body.error === "string" ? body.error : body.error?.message;
    throw new Error(error ?? `The decision failed (${res.status})`);
  }
  return { answers: body.answers, model: body.model };
}

const clients = new Map<string, ReturnType<typeof createMCPClient>>();

/** The workflow this step belongs to (set by the worker), if any. */
function workflowName(): string | undefined {
  const running = (globalThis as { makoWorkflow?: { getStore(): unknown } })
    .makoWorkflow;
  const name = running?.getStore();
  return typeof name === "string" ? name : undefined;
}

/** Mako's tools (queries, table inspection, apps, web search) for a model to use. */
export async function tools() {
  // One connection per workflow, opened on first use: Mako learns which
  // workflow writes, so a connection can allow that workflow alone.
  const workflow = workflowName() ?? "";
  let client = clients.get(workflow);
  if (!client) {
    client = createMCPClient({
      transport: {
        type: "http",
        url: `${url}/api/mcp`,
        headers: {
          Authorization: `Bearer ${key}`,
          ...(workflow ? { "X-Mako-Workflow": workflow } : {}),
        },
      },
    });
    clients.set(workflow, client);
  }
  return (await client).tools();
}

/** Call one Mako tool by name and return its result, e.g. `call("app_materialize", { appId, name })`. */
export async function call(
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const tool = (await tools())[name];
  if (!tool?.execute) throw new Error(`${name} is not available to this key`);
  const result = (await tool.execute(input, {
    toolCallId: name,
    messages: [],
  } as never)) as { content?: { text?: string }[]; isError?: boolean };
  // A tool answers with text; Mako's tools put their JSON result in it.
  const text = result.content?.map(part => part.text ?? "").join("") ?? "";
  if (result.isError) throw new Error(text || `${name} failed`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Run SQL on a workspace connection. Read-only unless the key and connection allow writes. */
export function query(connection: string, sql: string): Promise<unknown> {
  return call("sql_execute_query", { connectionId: connection, query: sql });
}
