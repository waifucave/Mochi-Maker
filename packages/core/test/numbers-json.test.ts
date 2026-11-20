import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  F32,
  F32Num,
  F32Points,
  decode,
  encode,
  f32,
  formatF32,
  parseJson,
  stringifyJson,
  EXTRA,
} from '@mochi-maker/core';
import { Type } from '@sinclair/typebox';

describe('float32 text', () => {
  it('reads back as the same float32, for any float32', () => {
    fc.assert(
      fc.property(fc.float({ noNaN: true, noDefaultInfinity: true }), (x) => {
        const v = f32(x);
        expect(Math.fround(Number(formatF32(v)))).toBe(v);
      }),
      { numRuns: 5000 },
    );
  });

  it('is short', () => {
    expect(formatF32(f32(0.1))).toBe('0.1');
    expect(formatF32(f32(-30))).toBe('-30');
    expect(formatF32(f32(1 / 3))).toBe('0.33333334');
    expect(formatF32(f32(-0))).toBe('0');
  });
});

describe('JSON writer', () => {
  it('puts scalar arrays on one line and nested arrays one item per line', () => {
    const text = stringifyJson({
      a: [1, 2],
      b: [
        [1, 2],
        [3, 4],
      ],
      c: {},
      d: [],
      e: 'x',
      f: new F32Num(f32(0.1)),
    });
    expect(text).toBe(
      '{\n  "a": [1, 2],\n  "b": [\n    [1, 2],\n    [3, 4]\n  ],\n  "c": {},\n  "d": [],\n  "e": "x",\n  "f": 0.1\n}\n',
    );
  });

  it('parses with or without a byte-order mark', () => {
    expect(parseJson('﻿{"a":1}')).toEqual({ a: 1 });
  });
});

describe('codec', () => {
  const S = Type.Object({
    kind: Type.Literal('t'),
    x: F32(),
    pts: F32Points(),
    n: Type.Union([Type.Integer(), Type.Null()]),
  });

  it('rounds float32 fields, builds typed arrays and round-trips', () => {
    const v = decode<{ x: number; pts: Float32Array }>(S, {
      kind: 't',
      x: 0.1,
      pts: [
        [0.1, -0],
        [2, 3],
      ],
      n: null,
    });
    expect(v.x).toBe(Math.fround(0.1));
    expect(v.pts).toBeInstanceOf(Float32Array);
    expect(Object.is(v.pts[1], -0)).toBe(false);
    const text = stringifyJson(encode(S, v));
    expect(text).toContain('"x": 0.1');
    expect(decode(S, JSON.parse(text))).toEqual(v);
  });

  it('keeps unknown keys and writes them back', () => {
    const v = decode<Record<string | symbol, unknown>>(S, {
      kind: 't',
      x: 1,
      pts: [],
      n: 3,
      future: { a: [1] },
    });
    expect(v[EXTRA]).toEqual({ future: { a: [1] } });
    expect(JSON.parse(stringifyJson(encode(S, v))).future).toEqual({ a: [1] });
  });

  it('reports the failing path', () => {
    expect(() => decode(S, { kind: 't', x: 'no', pts: [], n: null })).toThrow(
      /x: expected a finite number/,
    );
    expect(() => decode(S, { kind: 't', x: 1, pts: [[1]], n: null })).toThrow(/pts\[0\]/);
  });
});
