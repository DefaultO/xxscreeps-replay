export declare const BYTES_PER_ROOM = 625;
export declare function parseRoomName(name: string): {
    wx: number;
    wy: number;
} | undefined;
/** Side of the room grid a terrain.bin of `byteLength` bytes holds, or 0. */
export declare function terrainDim(byteLength: number): number;
/** A terrain.bin from room terrain strings (2500 characters of 0/1/2/3). */
export declare function terrainBinFromStrings(rooms: Iterable<{
    name: string;
    terrain: string;
}>): Buffer | undefined;
/**
 * Writes the world's terrain from the engine's map. `roomNames` is every
 * room the world has; anything else in the grid is wall.
 */
export declare function writeTerrainBin(file: string, world: {
    map: {
        getRoomTerrain(name: string): {
            get(x: number, y: number): number;
        };
    };
}, roomNames: Iterable<string>): void;
/** One room out of a terrain.bin, as the 2500-character string the client uses. */
export declare function roomFromTerrainBin(buffer: Uint8Array, room: string): string | undefined;
