import type { Database, Shard } from 'xxscreeps/engine/db/index.js';
import type { ReplayConfig } from './settings.js';
import type { Frame } from './format.js';
import { Recording } from './recording.js';
export interface RecorderStats {
    ticks: number;
    skipped: number;
    frames: number;
    bytes: number;
    msTotal: number;
    rooms: number;
    lastTick: number;
}
export declare class Recorder {
    private readonly db;
    private readonly shard;
    readonly config: ReplayConfig;
    readonly recording: Recording;
    readonly stats: RecorderStats;
    private world;
    private readonly rooms;
    private users;
    private usersRefreshed;
    private pending;
    private busy;
    private stopped;
    private unlisten;
    constructor(db: Database, shard: Shard, config: ReplayConfig);
    start(): Promise<void>;
    stop(): void;
    /** Closes every open chunk so what is on disk is complete up to now. */
    flush(): void;
    /** Frames held in memory for a room's current chunk. */
    liveFrames(room: string, chunkIndex: number): Frame[];
    private kick;
    private refreshUsers;
    private roomNames;
    private recordTick;
    private record;
    private render;
    private closeChunk;
}
