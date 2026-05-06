export class Timer {
  private readonly tStart: number;
  private tFirstByte: number | null = null;

  constructor() {
    this.tStart = Date.now();
  }

  markFirstByte(): void {
    if (this.tFirstByte === null) {
      this.tFirstByte = Date.now();
    }
  }

  latencyMs(): number {
    const end = this.tFirstByte ?? Date.now();
    return end - this.tStart;
  }
}
