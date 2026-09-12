import type { Codec } from './recording.js';
export interface ReplayConfig {
    enabled: boolean;
    dir: string;
    name: string | undefined;
    chunkTicks: number;
    historyChunkSize: number;
    codec: Codec;
    level: number | undefined;
    rooms: string[] | undefined;
    users: string[] | undefined;
    asUser: string | undefined;
    log: boolean;
    /** The shardreplay `web` directory that serves as the world view. */
    viewer: string | undefined;
}
export declare function replayConfig(): ReplayConfig;
