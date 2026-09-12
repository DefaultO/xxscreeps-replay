import type { Frame, HistoryTicks } from './format.js';
export declare const CODECS: {
    readonly none: 0;
    readonly zstd: 1;
    readonly brotli: 2;
};
export type Codec = keyof typeof CODECS;
export interface UserInfo {
    username: string;
    badge?: unknown;
}
export interface RoomMeta {
    /** Only in recordings made before terrain moved to terrain.bin. */
    terrain?: string;
    firstTick: number;
    lastTick: number;
    chunks: number;
    frames: number;
    bytes: number;
    /** The controller as last seen. */
    controller?: {
        user: string | null;
        level: number;
    };
}
/** What the world view's timeline marks: ownership, levels, invader raids. */
export type RecordingEvent = {
    kind: 'owner';
    tick: number;
    room: string;
    user: string | null;
} | {
    kind: 'level';
    tick: number;
    room: string;
    level: number;
    user: string;
} | {
    kind: 'raid';
    room: string;
    from: number;
    to: number;
    users: string[];
};
export interface RecordingMeta {
    version: 1;
    name: string;
    shard: string;
    created: number;
    /** Wall clock of the last save. */
    updated?: number;
    chunkTicks: number;
    codec: Codec;
    firstTick: number;
    lastTick: number;
    users: Record<string, UserInfo>;
    rooms: Record<string, RoomMeta>;
    /** Absent in recordings made before events were tracked (scanned on demand). */
    events?: RecordingEvent[];
}
export interface ChunkRecord {
    /** Absolute offset of the record header in its file. */
    offset: number;
    codec: number;
    firstTick: number;
    lastTick: number;
    frames: number;
    rawLength: number;
    length: number;
}
/** Where an entry's bytes live: a whole file, or a span of a bundle. */
export interface Entry {
    file: string;
    offset: number;
    length: number;
}
export declare const RECORD_HEADER = 28;
export declare const hasZstd: boolean;
/** The codec actually used for `codec` on this runtime. */
export declare function effectiveCodec(codec: Codec): Codec;
export declare function compress(raw: Uint8Array, codec: Codec, level?: number): Uint8Array;
export declare function decompress(data: Uint8Array, codec: number): Uint8Array;
export declare function encodeRecord(raw: Uint8Array, codec: Codec, firstTick: number, lastTick: number, frames: number, level?: number): Uint8Array;
/** Lists the records of a room entry by seeking over their headers. */
export declare function indexRecords(entry: Entry | string): ChunkRecord[];
/** Reads and decompresses one record's chunk. */
export declare function readRecord(file: string, record: ChunkRecord): Uint8Array;
/** The entries of a bundle file, by name, or undefined if it is not one. */
export declare function readBundleIndex(file: string): Map<string, Entry> | undefined;
/** Packs a recording directory into one bundle file. Returns bytes written. */
export declare function packRecording(dir: string, file: string): number;
/** Unpacks a bundle into a recording directory. */
export declare function unpackRecording(file: string, dir: string): void;
export interface HistoryChunk {
    timestamp: number;
    room: string;
    base: number;
    ticks: HistoryTicks;
}
export declare class Recording {
    readonly location: string;
    meta: RecordingMeta;
    private readonly entries?;
    private readonly indexes;
    private readonly frames;
    private terrainCache;
    /** What the recording is called in URLs: its directory or file name. */
    readonly name: string;
    /**
     * @param location the directory, or the bundle file
     * @param entries the bundle's entries; undefined for a directory
     */
    constructor(location: string, meta: RecordingMeta, entries?: Map<string, Entry> | undefined);
    /** A bundle is read-only. */
    get bundle(): boolean;
    /** The directory, for writers. */
    get dir(): string;
    static metaFile(dir: string): string;
    /** Opens a recording directory or a bundle file. */
    static open(location: string): Recording | undefined;
    static openDir(dir: string): Recording | undefined;
    static openBundle(file: string): Recording | undefined;
    /** Every recording under `root` - directories and bundles - newest first. */
    static list(root: string): Recording[];
    saveMeta(): void;
    /** Where a named entry lives, if it exists. */
    entry(name: string): Entry | undefined;
    /** The room file, for the recorder (directories only). */
    roomFile(room: string): string;
    rooms(): string[];
    index(room: string): ChunkRecord[];
    /** One record's chunk, decompressed. */
    readChunk(room: string, record: ChunkRecord): Uint8Array;
    /** Bytes the recording takes, all entries together. */
    size(): number;
    /** Forget cached state for a room after new records were appended. */
    invalidate(room: string): void;
    /** The world's terrain.bin; built from the rooms' own strings for old recordings. */
    terrainBin(): Buffer | undefined;
    /** A room's terrain as the 2500-character string the client uses. */
    terrain(room: string): string | undefined;
    chunkIndexOf(tick: number): number;
    /**
     * Every frame stored for one aligned chunk of `chunkTicks` ticks, in
     * order. A chunk closed early (a flush) and reopened yields two records
     * in the same range; both start with a keyframe so they concatenate.
     */
    chunkFrames(room: string, chunkIndex: number): Frame[];
    /** The room at one tick, if it was recorded. */
    frameAt(room: string, tick: number): Frame | undefined;
    /**
     * A room-history chunk in the official client's shape for ticks
     * [base, base + size). `live` supplies frames the recorder still holds
     * in memory for the chunk being written.
     */
    history(room: string, base: number, size: number, live?: (chunkIndex: number) => Frame[]): HistoryChunk | undefined;
}
