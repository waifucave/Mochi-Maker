/**
 * A small WebM writer: one VP9 or VP8 video track, with an alpha channel the WebM way,
 * as a second encoded stream in each block's BlockAdditions (BlockAddID 1) and `AlphaMode` on the
 * track. It is our own, because the encoders here cannot keep alpha themselves: the movie export
 * encodes the alpha as a second, grey video and pairs the two here.
 *
 * Layout: the EBML header; one Segment of known size with Info (1 ms timecodes, the duration),
 * Tracks, and a Cluster at each key frame. Frames without alpha are SimpleBlocks; frames with alpha
 * are BlockGroups, with a ReferenceBlock on delta frames.
 */

export interface WebmOptions {
  width: number;
  height: number;
  fps: number;
  codec: 'V_VP9' | 'V_VP8';
  alpha: boolean;
  /** The WritingApp field. */
  app?: string;
}

const text = new TextEncoder();

/** An element ID, as written (the ID's own marker bits included). */
function idBytes(id: number): Uint8Array {
  const n = id >= 0x1000000 ? 4 : id >= 0x10000 ? 3 : id >= 0x100 ? 2 : 1;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (id >>> (8 * (n - 1 - i))) & 0xff;
  return out;
}

/** A data size as an EBML variable-length integer, in the fewest bytes. */
export function vint(size: number): Uint8Array {
  let n = 1;
  while (n < 8 && size >= 2 ** (7 * n) - 1) n++;
  const out = new Uint8Array(n);
  let v = size;
  for (let i = n - 1; i >= 0; i--) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  out[0]! |= 0x80 >> (n - 1);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const el = (id: number, payload: Uint8Array): Uint8Array =>
  concat([idBytes(id), vint(payload.length), payload]);
const master = (id: number, children: Uint8Array[]): Uint8Array => el(id, concat(children));

function uintBytes(v: number): Uint8Array {
  const bytes: number[] = [];
  let x = Math.max(0, Math.round(v));
  do {
    bytes.unshift(x % 256);
    x = Math.floor(x / 256);
  } while (x > 0);
  return new Uint8Array(bytes);
}
const uint = (id: number, v: number) => el(id, uintBytes(v));

function intBytes(v: number): Uint8Array {
  // Two's complement in the fewest bytes (1–4 are enough for block references).
  for (let n = 1; n <= 4; n++) {
    const lo = -(2 ** (8 * n - 1));
    const hi = 2 ** (8 * n - 1) - 1;
    if (v >= lo && v <= hi) {
      const out = new Uint8Array(n);
      let x = v < 0 ? 2 ** (8 * n) + v : v;
      for (let i = n - 1; i >= 0; i--) {
        out[i] = x % 256;
        x = Math.floor(x / 256);
      }
      return out;
    }
  }
  throw new RangeError(`${v} does not fit a block reference.`);
}

function float64(id: number, v: number): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, v, false);
  return el(id, b);
}
const str = (id: number, s: string) => el(id, text.encode(s));

// Element IDs (Matroska / WebM).
const ID = {
  EBML: 0x1a45dfa3,
  EBMLVersion: 0x4286,
  EBMLReadVersion: 0x42f7,
  EBMLMaxIDLength: 0x42f2,
  EBMLMaxSizeLength: 0x42f3,
  DocType: 0x4282,
  DocTypeVersion: 0x4287,
  DocTypeReadVersion: 0x4285,
  Segment: 0x18538067,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Duration: 0x4489,
  MuxingApp: 0x4d80,
  WritingApp: 0x5741,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackUID: 0x73c5,
  TrackType: 0x83,
  FlagLacing: 0x9c,
  CodecID: 0x86,
  DefaultDuration: 0x23e383,
  MaxBlockAdditionID: 0x55ee,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  AlphaMode: 0x53c0,
  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  ReferenceBlock: 0xfb,
  BlockAdditions: 0x75a1,
  BlockMore: 0xa6,
  BlockAddID: 0xee,
  BlockAdditional: 0xa5,
} as const;

interface Frame {
  data: Uint8Array;
  key: boolean;
  /** Milliseconds from the start. */
  ms: number;
  alpha?: Uint8Array;
}

export class WebmWriter {
  private readonly frames: Frame[] = [];

  constructor(readonly options: WebmOptions) {}

  /** Adds an encoded frame (and, with alpha, the encoded alpha frame), in time order. */
  addFrame(data: Uint8Array, key: boolean, timestampUs: number, alpha?: Uint8Array): void {
    const ms = Math.round(timestampUs / 1000);
    const last = this.frames.at(-1);
    if (last && ms < last.ms) throw new Error('WebM frames must come in time order.');
    if (!last && !key) throw new Error('The first WebM frame must be a key frame.');
    if (this.options.alpha && !alpha) throw new Error('This WebM has alpha: every frame needs it.');
    this.frames.push({ data, key, ms, alpha });
  }

  get frameCount(): number {
    return this.frames.length;
  }

  /** The whole file. */
  finish(): Uint8Array {
    const o = this.options;
    const header = master(ID.EBML, [
      uint(ID.EBMLVersion, 1),
      uint(ID.EBMLReadVersion, 1),
      uint(ID.EBMLMaxIDLength, 4),
      uint(ID.EBMLMaxSizeLength, 8),
      str(ID.DocType, 'webm'),
      uint(ID.DocTypeVersion, 4),
      uint(ID.DocTypeReadVersion, 2),
    ]);
    const frameMs = 1000 / o.fps;
    const durationMs = this.frames.length ? this.frames.at(-1)!.ms + frameMs : 0;
    const info = master(ID.Info, [
      uint(ID.TimecodeScale, 1_000_000),
      float64(ID.Duration, durationMs),
      str(ID.MuxingApp, 'Mochi Maker'),
      str(ID.WritingApp, o.app ?? 'Mochi Maker'),
    ]);
    const video = master(ID.Video, [
      uint(ID.PixelWidth, o.width),
      uint(ID.PixelHeight, o.height),
      ...(o.alpha ? [uint(ID.AlphaMode, 1)] : []),
    ]);
    const tracks = master(ID.Tracks, [
      master(ID.TrackEntry, [
        uint(ID.TrackNumber, 1),
        uint(ID.TrackUID, 1),
        uint(ID.TrackType, 1),
        uint(ID.FlagLacing, 0),
        str(ID.CodecID, o.codec),
        uint(ID.DefaultDuration, Math.round(1e9 / o.fps)),
        ...(o.alpha ? [uint(ID.MaxBlockAdditionID, 1)] : []),
        video,
      ]),
    ]);
    const clusters: Uint8Array[] = [];
    let cluster: Uint8Array[] = [];
    let clusterMs = 0;
    let prevRel = 0;
    const close = () => {
      if (cluster.length) clusters.push(master(ID.Cluster, cluster));
      cluster = [];
    };
    for (const f of this.frames) {
      // A cluster starts at each key frame, and before block times would overflow 16 bits.
      if (f.key || f.ms - clusterMs > 30_000 || cluster.length === 0) {
        close();
        clusterMs = f.ms;
        cluster.push(uint(ID.Timecode, clusterMs));
        prevRel = 0;
      }
      const rel = f.ms - clusterMs;
      const prelude = new Uint8Array(4);
      const dv = new DataView(prelude.buffer);
      dv.setUint8(0, 0x81); // track 1, as a one-byte vint
      dv.setInt16(1, rel, false);
      if (!f.alpha) {
        dv.setUint8(3, f.key ? 0x80 : 0);
        cluster.push(el(ID.SimpleBlock, concat([prelude, f.data])));
      } else {
        dv.setUint8(3, 0);
        cluster.push(
          master(ID.BlockGroup, [
            el(ID.Block, concat([prelude, f.data])),
            ...(f.key ? [] : [el(ID.ReferenceBlock, intBytes(prevRel - rel))]),
            master(ID.BlockAdditions, [
              master(ID.BlockMore, [uint(ID.BlockAddID, 1), el(ID.BlockAdditional, f.alpha)]),
            ]),
          ]),
        );
      }
      prevRel = rel;
    }
    close();
    const segment = master(ID.Segment, [info, tracks, ...clusters]);
    return concat([header, segment]);
  }
}

/** Reads the element tree back (for tests and checks): `[id, payload]` pairs of one level. */
export function readElements(b: Uint8Array, start = 0, end = b.length): [number, Uint8Array][] {
  const out: [number, Uint8Array][] = [];
  let i = start;
  while (i < end) {
    const first = b[i]!;
    let n = 1;
    while (n <= 4 && !(first & (0x80 >> (n - 1)))) n++;
    let id = 0;
    for (let k = 0; k < n; k++) id = id * 256 + b[i + k]!;
    i += n;
    const s0 = b[i]!;
    let m = 1;
    while (m <= 8 && !(s0 & (0x80 >> (m - 1)))) m++;
    let size = s0 & (0xff >> m);
    for (let k = 1; k < m; k++) size = size * 256 + b[i + k]!;
    i += m;
    out.push([id, b.subarray(i, i + size)]);
    i += size;
  }
  return out;
}
