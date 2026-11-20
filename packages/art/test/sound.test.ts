/** WAV header reading for sound.import. */
import { describe, expect, it } from 'vitest';
import { readWavInfo } from '@mochi-maker/art';
import { squareWav } from '../../export/test/golden.js';

function wav(format: number, bits: number, channels: number, frames: number, extensible = false) {
  const block = (bits / 8) * channels;
  const fmtSize = extensible ? 40 : 16;
  const data = new Uint8Array(12 + 8 + fmtSize + 8 + block * frames);
  const v = new DataView(data.buffer);
  const tag = (o: number, t: string) =>
    [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  tag(0, 'RIFF');
  v.setUint32(4, data.length - 8, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  v.setUint32(16, fmtSize, true);
  v.setUint16(20, extensible ? 0xfffe : format, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, 44100, true);
  v.setUint32(28, 44100 * block, true);
  v.setUint16(32, block, true);
  v.setUint16(34, bits, true);
  if (extensible) v.setUint16(20 + 24, format, true);
  const d = 20 + fmtSize;
  tag(d, 'data');
  v.setUint32(d + 4, block * frames, true);
  return data;
}

describe('readWavInfo', () => {
  it('reads PCM and float formats, mono and stereo, plain and extensible', () => {
    expect(readWavInfo(squareWav(0.5, 1))).toEqual({
      format: 1,
      bitsPerSample: 16,
      channels: 1,
      sampleRate: 16000,
      frames: 16000,
    });
    expect(readWavInfo(wav(3, 32, 2, 100))).toMatchObject({ format: 3, channels: 2, frames: 100 });
    expect(readWavInfo(wav(1, 24, 1, 7))).toMatchObject({ bitsPerSample: 24, frames: 7 });
    expect(readWavInfo(wav(1, 16, 2, 10, true))).toMatchObject({
      format: 1,
      channels: 2,
      frames: 10,
    });
  });

  it('refuses what it cannot read, with E_ASSET_FORMAT', () => {
    expect(() => readWavInfo(new Uint8Array(4))).toThrow(/no RIFF\/WAVE header/);
    expect(() => readWavInfo(wav(2, 4, 1, 10))).toThrow(/not PCM or 32-bit float/);
    expect(() => readWavInfo(wav(3, 64, 1, 10))).toThrow(/not PCM or 32-bit float/);
    const noData = wav(1, 16, 1, 0).subarray(0, 36);
    expect(() => readWavInfo(noData)).toThrow(/no data chunk/);
    try {
      readWavInfo(new Uint8Array(4), 'x.wav');
    } catch (e) {
      expect((e as { code: string }).code).toBe('E_ASSET_FORMAT');
    }
  });
});
