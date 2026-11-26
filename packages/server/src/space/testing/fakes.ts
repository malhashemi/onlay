/**
 * In-process `Clock` and `Sockets` for `bun test` of the space runtime: a
 * clock the test moves by hand, and sockets that record what was sent.
 */
import type { Clock, Socket, Sockets } from "../ports";

export class ManualClock implements Clock {
  constructor(private t = 1_750_000_000_000) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

class FakeSocket<A> implements Socket<A> {
  readonly sent: string[] = [];
  closed: { code: number; reason: string } | null = null;
  private data: A | null = null;

  send(data: string): void {
    if (!this.closed) this.sent.push(data);
  }
  close(code: number, reason: string): void {
    this.closed ??= { code, reason };
  }
  attachment(): A | null {
    return this.data;
  }
  setAttachment(attachment: A): void {
    // The Durable Object stores a structured clone; so does the fake.
    this.data = structuredClone(attachment);
  }
  /** Every sent frame, parsed. */
  frames(): unknown[] {
    return this.sent.map((s) => JSON.parse(s));
  }
}

export class FakeSockets<A> implements Sockets<A> {
  private readonly open = new Set<FakeSocket<A>>();

  /** A newly connected socket. */
  connect(): FakeSocket<A> {
    const socket = new FakeSocket<A>();
    this.open.add(socket);
    return socket;
  }
  all(): FakeSocket<A>[] {
    return [...this.open].filter((s) => s.closed === null);
  }
}
