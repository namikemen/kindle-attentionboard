export type TimerPhase = 'focus' | 'break';

export interface TimerState {
  isRunning: boolean;
  phase: TimerPhase;
  durationSeconds: number;
  remainingSeconds: number;
  progressPercent: number;
  completedPomodoros: number;
  timeFormatted: string;
}

class TimerManager {
  private isRunning: boolean = false;
  private phase: TimerPhase = 'focus';
  private durationSeconds: number = 25 * 60;
  private remainingSeconds: number = 25 * 60;
  private completedPomodoros: number = 0;
  private lastTickTimestamp: number = Date.now();
  private intervalId: NodeJS.Timeout | null = null;

  constructor() {
    this.startTicker();
  }

  private startTicker(): void {
    if (this.intervalId) clearInterval(this.intervalId);
    this.intervalId = setInterval(() => {
      this.tick();
    }, 1000);
  }

  private tick(): void {
    const now = Date.now();
    const deltaSeconds = Math.round((now - this.lastTickTimestamp) / 1000);
    this.lastTickTimestamp = now;

    if (!this.isRunning) return;

    if (this.remainingSeconds > 0) {
      this.remainingSeconds = Math.max(0, this.remainingSeconds - Math.max(1, deltaSeconds));
    } else {
      // Phase transition
      if (this.phase === 'focus') {
        this.completedPomodoros += 1;
        this.phase = 'break';
        this.durationSeconds = 5 * 60;
        this.remainingSeconds = 5 * 60;
      } else {
        this.phase = 'focus';
        this.durationSeconds = 25 * 60;
        this.remainingSeconds = 25 * 60;
      }
    }
  }

  public start(): void {
    this.isRunning = true;
    this.lastTickTimestamp = Date.now();
  }

  public pause(): void {
    this.isRunning = false;
  }

  public toggle(): void {
    if (this.isRunning) {
      this.pause();
    } else {
      this.start();
    }
  }

  public reset(durationMinutes?: number): void {
    this.isRunning = false;
    const mins = durationMinutes && durationMinutes > 0 ? durationMinutes : 25;
    this.durationSeconds = mins * 60;
    this.remainingSeconds = mins * 60;
    this.phase = 'focus';
  }

  public setPhase(phase: TimerPhase, durationMinutes: number): void {
    this.phase = phase;
    this.durationSeconds = durationMinutes * 60;
    this.remainingSeconds = durationMinutes * 60;
  }

  public getState(): TimerState {
    const mins = Math.floor(this.remainingSeconds / 60);
    const secs = this.remainingSeconds % 60;
    const timeFormatted = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    const elapsed = this.durationSeconds - this.remainingSeconds;
    const progressPercent = this.durationSeconds > 0
      ? Math.min(100, Math.round((elapsed / this.durationSeconds) * 100))
      : 0;

    return {
      isRunning: this.isRunning,
      phase: this.phase,
      durationSeconds: this.durationSeconds,
      remainingSeconds: this.remainingSeconds,
      progressPercent,
      completedPomodoros: this.completedPomodoros,
      timeFormatted,
    };
  }
}

export const timerManager = new TimerManager();
