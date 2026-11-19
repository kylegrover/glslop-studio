// A deadline must NEVER turn non-blocking compiler polling into a blocking status query. The old
// 60-second fallback did exactly that, and several corpus shaders take longer than a minute.
// Timeout means a failed load, not permission to ask COMPILE_STATUS/LINK_STATUS before readiness.
export async function waitForCompile(o: {
  ready: () => boolean;
  cancelled: () => boolean;
  tick: () => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
}): Promise<'ready' | 'cancelled' | 'timeout'> {
  const now = o.now ?? (() => performance.now());
  const deadline = now() + (o.timeoutMs ?? 180_000);
  while (!o.cancelled()) {
    if (o.ready()) return 'ready';
    if (now() >= deadline) return 'timeout';
    await o.tick();
  }
  return 'cancelled';
}
