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
    offset: number;
    codec: number;
    firstTick: number;
    lastTick: number;
    frames: number;
    rawLength: number;
    length: number;
}
export declare const RECORD_HEADER = 28;
export declare const hasZstd: boolean;
/** The codec actually used for `codec` on this runtime. */
export declare function effectiveCodec(codec: Codec): Codec;
export declare function compress(raw: Uint8Array, codec: Codec, level?: number): Uint8Array;
export declare function decompress(data: Uint8Array, codec: number): Uint8Array;
export declare function encodeRecord(raw: Uint8Array, codec: Codec, firstTick: number, lastTick: number, frames: number, level?: number): Uint8Array;
/** Lists the records in an .xrr file by seeking over their headers. */
export declare function indexRecords(file: string): ChunkRecord[];
/** Reads and decompresses one record's chunk. */
export declare function readRecord(file: string, record: ChunkRecord): Uint8Array;
export interface HistoryChunk {
    timestamp: number;
    room: string;
    base: number;
    ticks: HistoryTicks;
}
export declare class Recording {
    readonly dir: string;
    meta: RecordingMeta;
    private readonly indexes;
    private readonly frames;
    constructor(dir: string, meta: RecordingMeta);
    static metaFile(dir: string): string;
    static open(dir: string): Recording | undefined;
    /** Every recording under `root`, newest first. */
    static list(root: string): Recording[];
    saveMeta(): void;
    roomFile(room: string): string;
    rooms(): string[];
    index(room: string): ChunkRecord[];
    /** Forget cached state for a room after new records were appended. */
    invalidate(room: string): void;
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
