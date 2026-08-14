/**
 * Teaching sketch — reactive coeffects (论文 §3.2 / Table 2).
 *
 * 部件用一份规格声明自己需要什么；上下文一变，对照规格通知：
 *   activating   — 刚才不满足，现在满足 → 该启动
 *   deactivating — 刚才满足，现在不满足 → 该停用
 *   neutral      — 满足性没变 → 没事
 *
 * 真实字段是 `fiber.inject`（余效应规格 d）。不齐就不会 ACTIVE。
 * 本文件不是上游源码副本。
 *
 * AgentLoop（packages/core/agent-loop）公开的规格：
 *   static inject = ['agents', 'sessions', 'llm', 'tools', 'systemPrompt']
 * 这五个服务不齐，loop 插件不会变成 ACTIVE。
 */

export type NotifyKind = "activating" | "deactivating" | "neutral";

/** Paper notify: activating / deactivating / neutral. */
export function classify(wasSatisfied: boolean, nowSatisfied: boolean): NotifyKind {
  if (!wasSatisfied && nowSatisfied) return "activating";
  if (wasSatisfied && !nowSatisfied) return "deactivating";
  return "neutral";
}

/**
 * Tiny stand-in for a fiber that only stores its coeffect spec.
 * Real fields also include apply / dispose / committed / target / inertia / state.
 */
export class TinyFiber {
  constructor(
    readonly name: string,
    /** d — coeffect spec. Real field: fiber.inject */
    readonly inject: readonly string[],
  ) {}

  satisfied(available: ReadonlySet<string>): boolean {
    return this.inject.every((key) => available.has(key));
  }

  missing(available: ReadonlySet<string>): string[] {
    return this.inject.filter((key) => !available.has(key));
  }
}

/**
 * Teaching stand-in for AgentLoop's static inject.
 * Not a copy of packages/core/agent-loop/src/index.ts.
 */
export const agentLoopFiber = new TinyFiber("agentLoop", [
  "agents",
  "sessions",
  "llm",
  "tools",
  "systemPrompt",
]);

export function notify(
  fiber: TinyFiber,
  before: ReadonlySet<string>,
  after: ReadonlySet<string>,
): { kind: NotifyKind; missing: string[] } {
  const kind = classify(fiber.satisfied(before), fiber.satisfied(after));
  return { kind, missing: fiber.missing(after) };
}

export function demo(): void {
  const store = new Set<string>();
  const steps: Array<readonly string[]> = [
    ["agents", "sessions"],
    ["llm", "tools"],
    ["systemPrompt"],
    [], // still complete
    ["-llm"], // power cut: llm disappears
  ];

  let before = new Set(store);
  for (const keys of steps) {
    for (const key of keys) {
      if (key.startsWith("-")) store.delete(key.slice(1));
      else store.add(key);
    }
    const after = new Set(store);
    const { kind, missing } = notify(agentLoopFiber, before, after);
    console.log({
      available: [...store],
      kind,
      missing,
    });
    before = after;
  }
}

demo();
