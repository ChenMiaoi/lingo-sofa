/** Connections are leases: unclean exits expire instead of keeping a daemon alive. */
export class ClientLeases {
  private clients = new Map<string, number>();
  private emptySince: number;
  constructor(
    private readonly ttl = 45_000,
    private readonly grace = 60_000,
    now = Date.now(),
  ) {
    this.emptySince = now;
  }
  renew(origin: string, id: string, now = Date.now()) {
    this.sweep(now);
    if (this.clients.size >= 100 && !this.clients.has(`${origin}|${id}`))
      throw new Error("Too many runtime clients");
    this.clients.set(`${origin}|${id}`, now + this.ttl);
  }
  release(origin: string, id: string, now = Date.now()) {
    this.sweep(now);
    if (this.clients.delete(`${origin}|${id}`) && !this.clients.size)
      this.emptySince = now;
  }
  private sweep(now: number) {
    const expired = [...this.clients].filter(([, until]) => until <= now);
    if (expired.length && expired.length === this.clients.size)
      this.emptySince = Math.max(...expired.map(([, until]) => until));
    for (const [id] of expired) this.clients.delete(id);
  }
  shouldStop(busy: boolean, now = Date.now()) {
    this.sweep(now);
    return !busy && !this.clients.size && now - this.emptySince >= this.grace;
  }
  get count() {
    this.sweep(Date.now());
    return this.clients.size;
  }
}
