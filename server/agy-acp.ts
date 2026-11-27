import type { Writable } from "node:stream";

export interface AgyAcpOptions {
  url: string;
  token: string;
  model: string;
  effort: string;
  fullAccess?: boolean;
  mode?: "default" | "accept-edits";
}

interface ConfigOption {
  id: string;
  category?: string;
  currentValue?: string;
  options?: { value?: string; name?: string; options?: { value: string; name: string }[] }[];
}

const acpToolKinds = new Set(["read", "edit", "delete", "move", "search", "execute", "think", "fetch", "switch_mode", "other"]);

// One ACP worker and one outstanding client request per Relaydesk turn.
// Feed events into the existing Agy parser so redaction and output limits stay shared.
export function agyAcpTurn(
  options: AgyAcpOptions,
  cwd: string,
  resumeId: string,
  prompt: string,
  stdin: Writable,
  emitLine: (line: string) => void,
) {
  let buffer = "";
  let id = 0;
  let method = "";
  let sessionId = resumeId;
  let finished = false;
  let modelChanging = false;
  const settings: { method: string; params: Record<string, unknown> }[] = [];
  const tools = new Map<string, { index: number; name: string; title: string }>();
  const send = (message: object) => stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
  const emit = (event: object) => emitLine(JSON.stringify(event) + "\n");
  function request(name: string, params: object) {
    method = name;
    send({ id: ++id, method, params });
  }
  function finish(error?: string) {
    if (finished) return;
    finished = true;
    emit({ event: "result", result: error ? { status: "ERROR", error } : { status: "SUCCESS" } });
    stdin.end();
  }
  function configure(optionList: ConfigOption[], category: string, selection: string) {
    if (!selection) return;
    const option = optionList.find((o) => o.category === category || o.id === category);
    const values = option?.options?.flatMap<{ value?: string; name?: string }>((o) => o.options ?? [o]) ?? [];
    const value = values.find(
      (o) => o.value === selection || o.name?.toLowerCase() === selection.toLowerCase(),
    )?.value;
    if (option?.currentValue === selection) return;
    if (!option || !value)
      throw new Error("Agy ACP does not offer the requested " + category + ": " + selection);
    if (value !== option.currentValue) {
      if (category === "model") modelChanging = true;
      settings.push({ method: "session/set_config_option", params: { configId: option.id, value } });
    }
  }
  function next() {
    const setting = settings.shift();
    if (setting) request(setting.method, { sessionId, ...setting.params });
    else request("session/prompt", { sessionId, prompt: [{ type: "text", text: prompt }] });
  }
  function handle(line: string) {
    if (line.length > 16 * 1024 * 1024) throw new Error("Agy ACP frame exceeded limit");
    const msg = JSON.parse(line);
    if (msg.method) {
      if (msg.id != null) {
        if (msg.method === "session/request_permission") {
          const choices = options.fullAccess && sessionId && msg.params?.sessionId === sessionId &&
            Array.isArray(msg.params.options) ? msg.params.options : [];
          const allow = (kind: string) => choices.find((o: { kind?: string; optionId?: string } | null) =>
            o?.kind === kind && typeof o.optionId === "string" && o.optionId.length > 0);
          const selected = allow("allow_once") ?? allow("allow_always");
          const outcome = selected ? { outcome: "selected", optionId: selected.optionId } : { outcome: "cancelled" };
          send({ id: msg.id, result: { outcome } });
        } else send({ id: msg.id, error: { code: -32601, message: "Unsupported client method" } });
        return;
      }
      if (msg.method !== "session/update" || msg.params?.sessionId !== sessionId) return;
      const u = msg.params.update;
      const step = (fields: object) => emit({ event: "step_update", step_update: fields });
      if (u.sessionUpdate === "agent_message_chunk" || u.sessionUpdate === "agent_thought_chunk") {
        if (u.content?.type === "text")
          step({
            step_type: "agent_response",
            [u.sessionUpdate === "agent_message_chunk" ? "text_delta" : "thinking_delta"]: u.content.text,
          });
      } else if (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") {
        const tool = tools.get(u.toolCallId) ?? { index: tools.size, name: acpToolKinds.has(u.kind) ? u.kind as string : "tool", title: "" };
        if (typeof u.title === "string" && u.title.trim()) tool.title = u.title;
        tools.set(u.toolCallId, tool);
        step({
          step_type: "tool",
          step_index: tool.index,
          tool_name: tool.name,
          tool_title: tool.title,
          state: u.status === "completed" ? "DONE" : u.status === "failed" ? "ERROR" : "ACTIVE",
          tool_info: {
            parameters: u.rawInput,
            output: u.content
              ?.flatMap((c: { content?: { text?: string } }) => c.content?.text ?? [])
              .join("\n"),
          },
        });
      } else if (u.sessionUpdate === "usage_update") {
        step({ step_type: "agent_response", usage: { input_tokens: u.used } });
      }
      return;
    }
    if (msg.id !== id) return;
    if (msg.error) throw new Error(method + ": " + (msg.error.message || "ACP request failed"));
    const r = msg.result;
    if (method === "initialize") {
      if (!r.agentCapabilities?.mcpCapabilities?.http)
        throw new Error("Agy ACP requires HTTP MCP support (--process-per-session)");
      if (resumeId && !r.agentCapabilities.sessionCapabilities?.resume)
        throw new Error("Agy ACP cannot resume this conversation");
      request(resumeId ? "session/resume" : "session/new", {
        cwd,
        ...(resumeId ? { sessionId } : {}),
        mcpServers: [
          {
            name: "relaydesk",
            type: "http",
            url: options.url,
            headers: [{ name: "Authorization", value: "Bearer " + options.token }],
          },
        ],
      });
    } else if (method === "session/new" || method === "session/resume") {
      sessionId = r.sessionId || resumeId;
      if (!sessionId) throw new Error("Missing Agy ACP session ID");
      emit({ event: "init", conversation_id: sessionId });
      if (options.mode && r.modes?.currentModeId !== options.mode)
        settings.push({ method: "session/set_mode", params: { modeId: options.mode } });
      configure(r.configOptions ?? [], "model", options.model);
      if (!modelChanging) configure(r.configOptions ?? [], "thought_level", options.effort);
      next();
    } else if (method === "session/prompt") {
      finish(r.stopReason === "end_turn" ? undefined : "Agy ACP stopped: " + r.stopReason);
    } else {
      if (method === "session/set_config_option" && modelChanging) {
        modelChanging = false;
        configure(r.configOptions ?? [], "thought_level", options.effort);
      }
      next();
    }
  }
  return {
    start() {
      request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    },
    write(chunk: string) {
      if (finished) return;
      try {
        const lines = (buffer + chunk).split("\n");
        buffer = lines.pop()!;
        if (buffer.length > 16 * 1024 * 1024) throw new Error("Agy ACP frame exceeded limit");
        for (const line of lines) if (!finished && line.trim()) handle(line);
      } catch (err) {
        finish(
          err instanceof Error && !(err instanceof SyntaxError) ? err.message : "Invalid Agy ACP response",
        );
      }
    },
    close() {
      if (!finished) finish("Agy ACP closed before completing " + method);
    },
  };
}
