/**
 * Teaching sketch — revertible effects (论文 §3.1 / Table 2).
 *
 * 真实 Cordis API 是 `ctx.effect(callback)`：回调交出左逆，运行时记账。
 * 本文件不是 cordiverse/cordis 或 deepseek-ai/deepseek-harness 的源码副本。
 *
 * Kitchen analogy（与 analysis.md 同一套厨房）：
 *   装咖啡机 → 占用插座、台面、排水管。
 *   拆走 → 按 LIFO 恢复（先拔管子，再清台面，再还插座）。
 *   不能留下半截管子，也不能把邻居的冰箱一起拔掉。
 *
 * Table 2: effect_Γ(e) ↦ ctx.effect(callback)；累加器 g ↦ fiber.dispose（反序）。
 * 运行时不检查逆是否真能恢复（§5.1.1）——教学代码同样不检查。
 */

export type Disposer = () => void;

/**
 * Tiny stand-in for the dispose accumulator on a fiber.
 * Real code: Fiber.effect() collects disposers; dispose() runs them last-in-first-out.
 */
export class EffectStack {
  private readonly stack: Disposer[] = [];
  /** Labels in registration order; used only so the demo can print LIFO. */
  readonly labels: string[] = [];

  /**
   * Register a forward action. `forward` returns its left inverse.
   * Real API: `ctx.effect(callback)` — not this method name.
   */
  effect(forward: () => Disposer, label = "anon"): Disposer {
    const dispose = forward();
    this.labels.push(label);
    this.stack.push(dispose);
    return dispose;
  }

  /** Recover: run inverses last-in-first-out, then clear. 论文：逆按相反顺序堆积。 */
  disposeAll(): string[] {
    const ran: string[] = [];
    while (this.stack.length > 0) {
      const dispose = this.stack.pop()!;
      const label = this.labels.pop() ?? "anon";
      dispose();
      ran.push(label);
    }
    return ran;
  }
}

export type Kitchen = {
  outlet: "free" | "coffee-machine";
  counter: "clear" | "coffee-machine";
  drain: "open" | "hose-connected";
};

export function emptyKitchen(): Kitchen {
  return { outlet: "free", counter: "clear", drain: "open" };
}

/** Install one coffee machine as three stacked revertible effects. */
export function installCoffeeMachine(stack: EffectStack, kitchen: Kitchen): void {
  stack.effect(() => {
    kitchen.outlet = "coffee-machine";
    return () => {
      kitchen.outlet = "free";
    };
  }, "claim-outlet");

  stack.effect(() => {
    kitchen.counter = "coffee-machine";
    return () => {
      kitchen.counter = "clear";
    };
  }, "claim-counter");

  stack.effect(() => {
    kitchen.drain = "hose-connected";
    return () => {
      kitchen.drain = "open";
    };
  }, "connect-drain");
}

export function demo(): void {
  const kitchen = emptyKitchen();
  const stack = new EffectStack();
  installCoffeeMachine(stack, kitchen);
  console.log("after install:", { ...kitchen });
  const order = stack.disposeAll();
  console.log("dispose LIFO:", order.join(" → "));
  console.log("after dispose:", { ...kitchen });
}

demo();
