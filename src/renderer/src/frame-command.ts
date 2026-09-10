/** Coalesce continuous input to one latest value per frame and bounded IPC work. */
export class FrameCommand<T> {
  private pending: T | undefined;
  private frame = 0;
  private running = 0;

  constructor(
    private send: (value: T) => Promise<unknown>,
    private onError: (error: unknown) => void,
  ) {}

  queue(value: T) {
    this.pending = value;
    this.schedule();
  }
  private schedule() {
    if (this.pending === undefined || this.frame || this.running) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.flush();
    });
  }
  // Final input is sent synchronously before the gesture's end/undo command.
  flush() {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    const value = this.pending;
    this.pending = undefined;
    if (value === undefined) return;
    this.running++;
    void this.send(value)
      .catch(this.onError)
      .finally(() => {
        this.running--;
        this.schedule();
      });
  }
  cancel() {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.pending = undefined;
  }
}
