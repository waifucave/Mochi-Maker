/**
 * Files a person chooses or drops in the editor are checked by their sizes before they are read
 * (src/limits.ts). File objects that throw when read show that nothing over a cap is read.
 */
import { describe, expect, it } from 'vitest';
import { LIMITS } from '@mochi-maker/core';
import { fileBytes, fileText, folderBytes } from '../src/limits.js';

const MiB = 2 ** 20;

/** A File-like object of a given size that must not be read. */
const unread = (name: string, size: number, path = '') =>
  ({
    name,
    size,
    webkitRelativePath: path,
    arrayBuffer: () => Promise.reject(new Error(`${name} was read`)),
  }) as unknown as File;

describe('the editor’s file reads', () => {
  it('refuses one file over its cap without reading it', async () => {
    await expect(fileBytes(unread('big.psd', 600 * MiB))).rejects.toThrow(
      /big\.psd is too large: 600 MiB, more than the 512 MiB/,
    );
    await expect(fileText(unread('keys.json', 65 * MiB))).rejects.toThrow(/more than the 64 MiB/);
    const small = new File([new Uint8Array([1, 2])], 'a.png');
    expect(Array.from(await fileBytes(small))).toEqual([1, 2]);
  });

  it('refuses a folder over the caps before reading any of it', async () => {
    const caps = LIMITS.model;
    await expect(
      folderBytes([unread('t.png', 100 * MiB, 'm/t.png')], caps, 'The model folder'),
    ).rejects.toThrow(/The model folder: m\/t\.png is too large: 100 MiB/);
    await expect(
      folderBytes(
        Array.from({ length: 5 }, (_, i) => unread(`${i}.png`, 60 * MiB)),
        caps,
        'The model folder',
      ),
    ).rejects.toThrow(/all files together, is too large: 300 MiB, more than the 256 MiB/);
    await expect(
      folderBytes(
        Array.from({ length: 2001 }, (_, i) => unread(`${i}`, 1)),
        caps,
        'The model folder',
      ),
    ).rejects.toThrow(/2,001 files, more than the 2,000 files/);
  });
});
