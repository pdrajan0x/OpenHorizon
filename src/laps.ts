const SECTORS = 4;

/** Lap timing from track progress: a lap counts when the car crosses the start having visited every sector. */
export class LapTimer {
  current = 0;
  last: number | null = null;
  best: number | null = null;
  running = false;
  private visited = new Set<number>([0]);
  private lastSector = 0;

  constructor(private readonly sampleCount: number) {}

  start(): void {
    this.running = true;
  }

  update(dt: number, trackIndex: number): void {
    if (!this.running) return;
    this.current += dt;
    const sector = Math.floor((trackIndex / this.sampleCount) * SECTORS);
    if (sector === 0 && this.lastSector === SECTORS - 1 && this.visited.size === SECTORS) {
      this.last = this.current;
      this.best = this.best === null ? this.current : Math.min(this.best, this.current);
      this.current = 0;
      this.visited.clear();
    }
    this.visited.add(sector);
    this.lastSector = sector;
  }
}
