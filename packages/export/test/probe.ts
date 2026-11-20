/** Helpers for the round trip: evaluate an export in Mochi2D and compare with hand-computed values. */
import { expect } from 'vitest';
import type { ExportResult } from '@mochi-maker/export';
import { MemoryFileSource, ModelRuntime, scenarioResult } from 'mochi2d/headless';

export interface Drawable {
  id: string;
  visible: boolean;
  opacity: number;
  renderOrder: number;
  multiplyColor: number[];
  screenColor: number[];
  vertices: number[];
}

export function evaluate(
  r: ExportResult,
  stem: string,
  parameters: Record<string, number> = {},
): Map<string, Drawable> {
  const res = scenarioResult(
    { moc: r.files.get(`${stem}.moc3`)!, settings: r.files.get(`${stem}.model3.json`)! },
    { format: 'mochi2d-scenario/0', id: 'probe', parameters },
  ) as { error: unknown; drawables: Drawable[] };
  expect(res.error).toBeNull();
  return new Map(res.drawables.map((d) => [d.id, d]));
}

/** Canvas pixels → output space: model units with y up. */
export const out = (px: number, py: number, ox: number, oy: number, ppu: number) => [
  (px - ox) / ppu,
  -(py - oy) / ppu,
];

export function expectVertices(actual: number[], expected: number[], tol = 2e-5): void {
  expect(actual.length).toBe(expected.length);
  actual.forEach((v, i) =>
    expect(Math.abs(v - expected[i]!), `value ${i}: ${v} vs ${expected[i]}`).toBeLessThan(tol),
  );
}

/** The export loaded as an app would: Mochi2D's runtime over the exported files. */
export async function runtime(r: ExportResult, stem: string): Promise<ModelRuntime> {
  return ModelRuntime.load(new MemoryFileSource(stem, r.files), `${stem}.model3.json`);
}
