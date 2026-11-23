export declare const ICON_SOURCE: string;
export declare const ICON_DIR: string;
export declare function readShapes(svg: string): { fill: string; polygons: number[][][] }[];
export declare function rasterize(shapes: ReturnType<typeof readShapes>, size: number): Uint8Array;
export declare function ico(images: { size: number; data: Uint8Array }[]): Buffer;
export declare function icns(entries: [string, Uint8Array][]): Buffer;
export declare function buildIcons(dir?: string): Promise<Record<string, string>>;
