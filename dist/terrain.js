// terrain.bin: the whole world's terrain in one file, the layout the
// shardreplay viewer reads.
//
//   - a square grid of dim x dim rooms centred on the origin, tl = -dim/2;
//     room (wx, wy) sits at ((wy - tl) * dim + (wx - tl)) * 625
//   - a room is 625 bytes: 2500 tiles in row-major order (y, then x), 2 bits
//     each, four tiles a byte, the first tile in the low bits:
//     0 plain, 1 wall, 2 swamp, 3 wall and swamp (drawn as wall)
//   - dim is not stored: dim = sqrt(size / 625)
//   - rooms the world does not have are solid wall (every byte 0x55)
//
// Room names follow the game: W0 is wx = -1, E0 is wx = 0, N0 is wy = -1,
// S0 is wy = 0.
import * as fs from 'node:fs';
import * as path from 'node:path';
export const BYTES_PER_ROOM = 625;
const TILES = 2500;
const WALL_BYTE = 0x55;
export function parseRoomName(name) {
    const match = /^([WE])(\d+)([NS])(\d+)$/.exec(name);
    if (!match) {
        return undefined;
    }
    return {
        wx: match[1] === 'W' ? -Number(match[2]) - 1 : Number(match[2]),
        wy: match[3] === 'N' ? -Number(match[4]) - 1 : Number(match[4]),
    };
}
/** Side of the room grid a terrain.bin of `byteLength` bytes holds, or 0. */
export function terrainDim(byteLength) {
    const dim = Math.round(Math.sqrt(byteLength / BYTES_PER_ROOM));
    return dim * dim * BYTES_PER_ROOM === byteLength ? dim : 0;
}
/** The smallest centred grid that holds every one of these rooms. */
function gridFor(rooms) {
    let reach = 1;
    for (const pos of rooms) {
        reach = Math.max(reach, Math.abs(pos.wx) + 1, Math.abs(pos.wy) + 1);
    }
    const dim = reach * 2;
    return { dim, tl: -Math.floor(dim / 2) };
}
function roomOffset(pos, dim, tl) {
    return ((pos.wy - tl) * dim + (pos.wx - tl)) * BYTES_PER_ROOM;
}
function encodeRoom(buffer, offset, tile) {
    buffer.fill(0, offset, offset + BYTES_PER_ROOM);
    for (let index = 0; index < TILES; ++index) {
        buffer[offset + (index >> 2)] |= (tile(index) & 3) << ((index & 3) * 2);
    }
}
/** A terrain.bin from room terrain strings (2500 characters of 0/1/2/3). */
export function terrainBinFromStrings(rooms) {
    const placed = [...rooms].map(room => ({ pos: parseRoomName(room.name), terrain: room.terrain })).filter(room => room.pos && room.terrain.length >= TILES);
    if (placed.length === 0) {
        return undefined;
    }
    const { dim, tl } = gridFor(placed.map(room => room.pos));
    const buffer = Buffer.alloc(dim * dim * BYTES_PER_ROOM, WALL_BYTE);
    for (const room of placed) {
        encodeRoom(buffer, roomOffset(room.pos, dim, tl), index => room.terrain.charCodeAt(index) - 48);
    }
    return buffer;
}
/**
 * Writes the world's terrain from the engine's map. `roomNames` is every
 * room the world has; anything else in the grid is wall.
 */
export function writeTerrainBin(file, world, roomNames) {
    const rooms = [...roomNames].map(name => ({ name, pos: parseRoomName(name) })).filter(room => room.pos);
    const { dim, tl } = gridFor(rooms.map(room => room.pos));
    const buffer = Buffer.alloc(dim * dim * BYTES_PER_ROOM, WALL_BYTE);
    for (const room of rooms) {
        const terrain = world.map.getRoomTerrain(room.name);
        encodeRoom(buffer, roomOffset(room.pos, dim, tl), index => terrain.get(index % 50, Math.floor(index / 50)));
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buffer);
}
/** One room out of a terrain.bin, as the 2500-character string the client uses. */
export function roomFromTerrainBin(buffer, room) {
    const dim = terrainDim(buffer.length);
    const pos = parseRoomName(room);
    if (!dim || !pos) {
        return undefined;
    }
    const tl = -Math.floor(dim / 2);
    if (pos.wx < tl || pos.wy < tl || pos.wx >= tl + dim || pos.wy >= tl + dim) {
        return undefined;
    }
    const offset = roomOffset(pos, dim, tl);
    let out = '';
    for (let index = 0; index < TILES; ++index) {
        out += String((buffer[offset + (index >> 2)] >> ((index & 3) * 2)) & 3);
    }
    return out;
}
//# sourceMappingURL=terrain.js.map