import type { World } from 'xxscreeps/game/map.js';
import type { Frame } from './format.js';
import type { Recording, RecordingEvent } from './recording.js';
export interface ViewerContext {
    path: string;
    url: string;
    method: string;
    query: Record<string, string | string[] | undefined>;
    type: string;
    status: number;
    body: unknown;
    set(field: string, value: string): void;
    redirect(url: string): void;
}
export declare function parseRoomName(name: string): {
    wx: number;
    wy: number;
} | undefined;
/**
 * Writes the world's terrain in the viewer's layout: a square grid of rooms
 * centred on the origin, 2 bits a tile in row-major order. Rooms the world
 * does not have are solid wall.
 */
export declare function writeTerrainBin(file: string, world: World, roomNames: Iterable<string>): void;
/**
 * Controller changes and invader raids seen in one room's frames, appended
 * to `events`. `state` carries what was last seen so a scan can continue
 * across frames.
 */
export interface EventScanState {
    owner?: string | null;
    level?: number;
    raidFrom?: number;
    raidUsers?: Set<string>;
    lastTick?: number;
}
export declare function scanFrameEvents(room: string, frame: Frame, state: EventScanState, events: RecordingEvent[]): void;
/** Closes a raid still open when the frames end. */
export declare function finishEventScan(room: string, state: EventScanState, events: RecordingEvent[]): void;
export interface ViewerOptions {
    /** The shardreplay `web` directory. */
    dir: string | undefined;
    /** Directory of `<username>.svg` badge images. */
    badges?: string;
    /** The live world, for a recording that has no terrain.bin of its own. */
    world?: World;
    roomNames?: Iterable<string>;
}
/**
 * Answers one request under the viewer mount. Returns false when the path is
 * not part of the viewer (the caller keeps routing), true when answered.
 */
export declare function serveViewer(context: ViewerContext, recording: Recording, rest: string, options: ViewerOptions): Promise<boolean>;
