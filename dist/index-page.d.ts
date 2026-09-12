import type { Recording } from './recording.js';
export declare function historyUrl(recording: Recording, room: string, tick: number): string;
export interface IndexOptions {
    /** The recording being written right now, if any. */
    live?: Recording | undefined;
    /** Whether the world view (shardreplay) is configured. */
    viewer: boolean;
}
export declare function indexPage(recordings: Recording[], options: IndexOptions): string;
