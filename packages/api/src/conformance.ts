/**
 * Renders for the conformance pack in Node: Mochi2D's `NodeRenderer`, the reference
 * render (headless Chromium with SwiftShader), with premultiplied alpha as conformance compares.
 */
import { MOCHI2D_VERSION, MemoryFileSource, NodeRenderer } from 'mochi2d/node';
import { BUILD_TEXTURES, type PackRenderer } from '@mochi-maker/export';

/** Opens a renderer for `renderPack`; close it when done. Rejects when Chromium is missing. */
export async function openPackRenderer(): Promise<PackRenderer & { close(): Promise<void> }> {
  const r = await NodeRenderer.open();
  return {
    producer: `mochi2d@${MOCHI2D_VERSION}`,
    async render(files, settings, size, pose) {
      const img = await r.render(
        { source: new MemoryFileSource('pack', files), settings },
        {
          width: size.width,
          height: size.height,
          alpha: 'premultiplied',
          parameters: pose?.parameters ?? {},
          partOpacities: pose?.partOpacities ?? {},
          textures: BUILD_TEXTURES,
        },
      );
      if (!img.reference) throw new Error('Mochi2D did not make a reference render.');
      return {
        renderer: img.renderer,
        reference: img.reference,
        notes: img.notes,
        png: img.png,
        width: img.width,
        height: img.height,
        pixelsPerUnit: img.pixelsPerUnit,
        center: img.center,
      };
    },
    close: () => r.close(),
  };
}
