/**
 * Scrubbing with physics (M10's last part; Mochi2D 0.10.0's `savePhysicsState` and
 * `restorePhysicsState`). Moving the playhead shows the pose with physics as it would be at that
 * time: physics depends on everything before, so the state is computed, not looked up.
 *
 * A bake runtime (a fresh headless instance of the same export, nothing else running on it) steps
 * the motion forward at its frame rate from the start, and keeps a physics snapshot every
 * `interval` frames. It bakes lazily, only as far as the playhead has gone. To show frame F, the
 * shown runtime restores the nearest snapshot at or before F and steps the remaining frames
 * (fewer than `interval`). A restored run repeats the original bit for bit, so the result is the
 * same as running the motion from the start to F.
 *
 * Frame f is processed with the motion's parameter values at time f / fps and a step of 1 / fps;
 * frame 0 starts from the bake runtime's fresh physics state.
 */
import type { PhysicsState } from 'mochi2d';

/** What scrubbing needs of a Mochi2D model runtime. */
export interface PhysicsRuntime {
  setParameter(id: string, value: number): void;
  update(dt: number): void;
  savePhysicsState(): PhysicsState | null;
  restorePhysicsState(state: PhysicsState): void;
}

export class PhysicsScrubber {
  /** Snapshots after frame f; −1 is the fresh state before frame 0. */
  private readonly snapshots = new Map<number, PhysicsState>();
  /** The last frame the bake runtime has processed (−1: none). */
  private baked = -1;
  /** How many frames the last `show` stepped on the shown runtime. */
  lastSteps = 0;

  constructor(
    private readonly bake: PhysicsRuntime,
    /** The parameter values (base values, by ID) at frame f. */
    private readonly values: (frame: number) => Record<string, number>,
    readonly dt: number,
    readonly interval = 10,
  ) {
    const fresh = bake.savePhysicsState();
    if (!fresh) throw new Error('The model has no physics.');
    this.snapshots.set(-1, fresh);
  }

  private step(rt: PhysicsRuntime, frame: number): void {
    for (const [id, v] of Object.entries(this.values(frame))) rt.setParameter(id, v);
    rt.update(this.dt);
  }

  /** Bakes up to a frame (only the frames not baked yet). */
  bakeTo(frame: number): void {
    while (this.baked < frame) {
      this.baked++;
      this.step(this.bake, this.baked);
      if (this.baked % this.interval === 0)
        this.snapshots.set(this.baked, this.bake.savePhysicsState()!);
    }
  }

  /** The number of snapshots kept (the fresh state included). */
  get snapshotCount(): number {
    return this.snapshots.size;
  }

  /**
   * Puts the shown runtime in the state after frame `frame`: the nearest snapshot at or before
   * it, then the frames after the snapshot.
   */
  show(rt: PhysicsRuntime, frame: number): void {
    const f = Math.max(0, Math.floor(frame));
    this.bakeTo(Math.floor(f / this.interval) * this.interval);
    let s = Math.floor(f / this.interval) * this.interval;
    while (s >= 0 && !this.snapshots.has(s)) s -= this.interval;
    if (s < 0) s = -1;
    rt.restorePhysicsState(this.snapshots.get(s)!);
    this.lastSteps = 0;
    for (let k = s + 1; k <= f; k++) {
      this.step(rt, k);
      this.lastSteps++;
    }
    // A frame of no time shows the restored outputs (Mochi2D holds physics in zero steps, holdPhysicsInZeroSteps).
    rt.update(0);
  }
}
