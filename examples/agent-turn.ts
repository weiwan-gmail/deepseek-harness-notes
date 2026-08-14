/**
 * Teaching sketch — one toy agent turn as a session event log.
 *
 * 真实循环更长（step/start、agent/pre-step、llm.stream、tools/*、step/end …），
 * 见 analysis.md「一个完整例子」与 Harness docs/architecture.md。
 *
 * 本文件只演示排放顺序的最小骨架（用户指定的教学顺序）：
 *   turn/start → user/message → assistant/chunk → assistant/message
 *   → tool/call → tool/result → turn/end
 *
 * 会话日志是只追加排放（§6.1 emission），不是论文里的 Sigma。
 * 先 append(tool/call) 再执行——「模型可见即已记录」。
 * append 不能用 fiber.dispose 撤回；卸插件不会擦掉已经写出的日志。
 *
 * 不是 deepseek-ai/deepseek-harness 的源码副本。
 */

export type SessionEvent =
  | { type: "turn/start"; turn: number }
  | { type: "user/message"; text: string }
  | { type: "assistant/chunk"; text: string }
  | { type: "assistant/message"; text: string }
  | { type: "tool/call"; name: string; args: Record<string, unknown> }
  | { type: "tool/result"; name: string; result: string }
  | { type: "turn/end"; reason: string };

export const TOY_EVENT_ORDER = [
  "turn/start",
  "user/message",
  "assistant/chunk",
  "assistant/message",
  "tool/call",
  "tool/result",
  "turn/end",
] as const;

/**
 * Append one user utterance as a single-step turn that calls bash `ls`.
 * Kitchen / repo example from the reading: 「看看仓库根目录有哪些文件」。
 */
export function toyTurn(log: SessionEvent[], userText: string, turn = 1): SessionEvent[] {
  log.push({ type: "turn/start", turn });
  log.push({ type: "user/message", text: userText });

  // llm.stream → one visible chunk, then the assembled assistant message.
  const spoken = "I'll list the repository root.";
  log.push({ type: "assistant/chunk", text: spoken });
  log.push({ type: "assistant/message", text: spoken });

  // Model-visible then execute. Real executeToolCalls appends tool/call first.
  log.push({ type: "tool/call", name: "bash", args: { command: "ls" } });
  log.push({
    type: "tool/result",
    name: "bash",
    result: "README.md\nanalysis.md\nexamples\nnotes\npaper",
  });

  log.push({ type: "turn/end", reason: "natural" });
  return log;
}

export function eventTypes(log: readonly SessionEvent[]): string[] {
  return log.map((event) => event.type);
}

export function demo(): void {
  const log: SessionEvent[] = [];
  toyTurn(log, "看看仓库根目录有哪些文件");
  console.log(eventTypes(log).join(" → "));
  console.log(JSON.stringify(log, null, 2));
}

demo();
