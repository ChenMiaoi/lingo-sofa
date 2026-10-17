/** Serial reads pause while hidden; responses from an earlier visibility epoch are discarded. */
export function pollWhileVisible<T>(
  read: () => Promise<T>,
  receive: (value: T) => void,
  fail: (error: unknown) => void,
  visibility: Pick<
    Document,
    "hidden" | "addEventListener" | "removeEventListener"
  > = document,
  interval = 2_000,
): () => void {
  let stopped = false;
  let running = false;
  let epoch = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function refresh() {
    if (stopped || running || visibility.hidden) return;
    running = true;
    const revision = epoch;
    try {
      const value = await read();
      if (!stopped && !visibility.hidden && revision === epoch) receive(value);
    } catch (error) {
      if (!stopped && !visibility.hidden && revision === epoch) fail(error);
    } finally {
      running = false;
      if (!stopped && !visibility.hidden)
        timer = setTimeout(
          () => void refresh(),
          revision === epoch ? interval : 0,
        );
    }
  }
  const changed = () => {
    epoch++;
    clearTimeout(timer);
    if (!visibility.hidden) void refresh();
  };
  visibility.addEventListener("visibilitychange", changed);
  void refresh();
  return () => {
    stopped = true;
    epoch++;
    clearTimeout(timer);
    visibility.removeEventListener("visibilitychange", changed);
  };
}
