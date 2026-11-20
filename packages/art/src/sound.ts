/**
 * Sound import: reads a WAV file, checks its format, stores it as an asset
 * and creates a sound object. Mochi Maker's own reader of the RIFF/WAVE header: PCM integers of 8,
 * 16, 24 or 32 bits, or 32-bit floats, any channel count.
 */
import { Type } from '@sinclair/typebox';
import { MochiError, defineOperation } from '@mochi-maker/core';

export interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** 1 = PCM integers, 3 = IEEE floats. */
  format: number;
  /** Samples per channel. */
  frames: number;
}

/** Reads a WAV file's header; throws E_ASSET_FORMAT when it is not a WAV file this can read. */
export function readWavInfo(bytes: Uint8Array, what = 'WAV file'): WavInfo {
  const fail = (why: string): never => {
    throw new MochiError('E_ASSET_FORMAT', `${what} is not a readable WAV file: ${why}.`);
  };
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number) => String.fromCharCode(...bytes.subarray(o, o + 4));
  if (bytes.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') fail('no RIFF/WAVE header');
  let fmt: Omit<WavInfo, 'frames'> | undefined;
  let blockAlign = 0;
  for (let o = 12; o + 8 <= bytes.length;) {
    const id = tag(o);
    const size = v.getUint32(o + 4, true);
    const body = o + 8;
    if (id === 'fmt ') {
      if (size < 16) fail('the fmt chunk is too short');
      let format = v.getUint16(body, true);
      const channels = v.getUint16(body + 2, true);
      const sampleRate = v.getUint32(body + 4, true);
      blockAlign = v.getUint16(body + 12, true);
      const bitsPerSample = v.getUint16(body + 14, true);
      // WAVE_FORMAT_EXTENSIBLE: the real format is in the sub-format GUID's first two bytes.
      if (format === 0xfffe && size >= 26) format = v.getUint16(body + 24, true);
      fmt = { format, channels, sampleRate, bitsPerSample };
    } else if (id === 'data') {
      if (!fmt) fail('the data chunk comes before the fmt chunk');
      const f = fmt!;
      const ok =
        (f.format === 1 && [8, 16, 24, 32].includes(f.bitsPerSample)) ||
        (f.format === 3 && f.bitsPerSample === 32);
      if (!ok) fail(`format ${f.format} with ${f.bitsPerSample} bits is not PCM or 32-bit float`);
      if (f.channels < 1 || f.sampleRate < 1 || blockAlign < 1) fail('no channels or no rate');
      const length = Math.min(size, bytes.length - body);
      return { ...f, frames: Math.floor(length / blockAlign) };
    }
    o = body + size + (size % 2);
  }
  return fail('no data chunk');
}

export const soundImport = defineOperation({
  name: 'sound.import',
  summary: 'Import a WAV file as a sound, for motions to start (and lip sync to follow).',
  doc: `Reads the file, checks that it is a WAV file (PCM 8, 16, 24 or 32 bits, or 32-bit float), stores
it in the asset store and runs sound.create. \`name\` defaults to the file name without its
extension. Attach it to a motion with motion.update { target, sound }.`,
  args: Type.Object({
    path: Type.String({ description: 'a .wav file' }),
    name: Type.Optional(Type.String({ minLength: 1 })),
  }),
  result: Type.Object({
    uid: Type.String(),
    sampleRate: Type.Integer(),
    channels: Type.Integer(),
    frames: Type.Integer(),
    seconds: Type.Number(),
  }),
  errors: ['E_ASSET_FORMAT', 'E_NOT_FOUND'],
  examples: [{ description: 'Import a voice line', args: { path: 'voice/hello.wav' } }],
  async run(ctx, tx, a) {
    if (!ctx.fs)
      throw new MochiError(
        'E_ASSET_FORMAT',
        'Importing files needs file access, which this session does not have.',
      );
    const bytes = await ctx.fs.readBytes(a.path);
    const info = readWavInfo(bytes, a.path);
    const asset = await ctx.assets.put(bytes);
    const name =
      a.name ??
      (a.path
        .split(/[\\/]/)
        .pop()!
        .replace(/\.wav$/i, '') ||
        'sound');
    const { uid } = tx.run('sound.create', {
      name,
      asset,
      sampleRate: info.sampleRate,
      channels: info.channels,
      frames: info.frames,
    }) as { uid: string };
    return {
      result: {
        uid,
        sampleRate: info.sampleRate,
        channels: info.channels,
        frames: info.frames,
        seconds: info.frames / info.sampleRate,
      },
    };
  },
});
