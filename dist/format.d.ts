export type Leaf = null | boolean | number | string | unknown[] | Record<string, unknown>;
export type Flat = Map<string, Leaf>;
export type Objects = Map<string, Record<string, unknown>>;
export declare const FORMAT_VERSION = 1;
export declare class Writer {
    private buffer;
    length: number;
    private reserve;
    u8(value: number): void;
    varint(value: number): void;
    zigzag(value: number): void;
    float(value: number): void;
    bytes(value: Uint8Array): void;
    string(value: string): void;
    append(value: Uint8Array): void;
    finish(): Uint8Array;
}
export declare class Reader {
    private readonly buffer;
    offset: number;
    constructor(buffer: Uint8Array, offset?: number);
    get done(): boolean;
    u8(): number;
    varint(): number;
    zigzag(): number;
    float(): number;
    bytes(): Uint8Array<ArrayBufferLike>;
    string(): string;
}
export declare const EMPTY: Record<string, never>;
export declare function flatten(value: Record<string, unknown>, into?: Flat, prefix?: string): Flat;
export declare function unflatten(flat: Flat): Record<string, unknown>;
export declare class ChunkEncoder {
    firstTick: number;
    lastTick: number;
    frameCount: number;
    private readonly tables;
    private readonly objects;
    private nextIndex;
    private readonly frames;
    get empty(): boolean;
    /** Raw (uncompressed) size so far, for flush heuristics. */
    get size(): number;
    addFrame(tick: number, objects: Objects): void;
    finish(): Uint8Array;
}
export interface Frame {
    tick: number;
    /** The room at that tick as nested client JSON, keyed by object id. */
    objects: Objects;
}
export declare class ChunkDecoder {
    readonly firstTick: number;
    readonly lastTick: number;
    readonly frameCount: number;
    private readonly keys;
    private readonly strings;
    private readonly reader;
    private readonly objects;
    private readonly ids;
    private nextIndex;
    private decoded;
    private tick;
    /** Delta entries seen per field path, plus `+object` / `-object` counts. */
    readonly stats: Map<string, number>;
    constructor(raw: Uint8Array);
    get done(): boolean;
    /** Decodes the next frame, or returns null after the last one. */
    next(): Frame | null;
    private count;
    /** The room as nested client JSON, keyed by object id. */
    snapshot(): Objects;
    /** Decodes every frame. */
    static all(raw: Uint8Array): Frame[];
}
/**
 * The diff the room socket sends: changed fields only, `null` for a removed
 * field or object, arrays as index-keyed objects.
 */
export declare function diff(previous: unknown, next: unknown): unknown;
export type HistoryTicks = Record<string, Record<string, unknown> | null>;
/**
 * Builds the `ticks` block of a room-history chunk: the first recorded tick
 * in [base, base + size) in full, later recorded ticks as diffs against the
 * previous recorded tick, unrecorded ticks as `null`.
 */
export declare function historyTicks(frames: Iterable<Frame>, base: number, size: number): HistoryTicks;
