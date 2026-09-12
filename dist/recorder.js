// The recorder runs in the backend process. Every tick it loads the rooms
// players are present in (the same double-buffered blob the room socket
// reads), renders their objects exactly like the socket does, and feeds the
// frames to a per-room chunk encoder. Rooms nobody is in are not recorded:
// the engine can reproduce them from the terrain alone.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Render } from 'xxscreeps/backend/symbols.js';
import * as User from 'xxscreeps/engine/db/user/index.js';
import { userToPresenceRoomsSetKey } from 'xxscreeps/engine/processor/model.js';
import { runOneShot } from 'xxscreeps/game/index.js';
import { ChunkEncoder } from './format.js';
import { Recording, encodeRecord } from './recording.js';
import { badgeFromFile } from './badge.js';
import { writeTerrainBin } from './terrain.js';
import { finishEventScan, scanFrameEvents } from './viewer.js';
const isSystemUser = (userId) => userId.length <= 2;
class RoomRecorder {
    name;
    meta;
    file;
    encoder;
    chunkIndex = -1;
    /** Frames of the chunk being written, for the live history route. */
    live = [];
    lastTick;
    /** Controller and raid state, for the world view's timeline. */
    scan = {};
    fd;
    constructor(name, meta, file) {
        this.name = name;
        this.meta = meta;
        this.file = file;
    }
    append(record) {
        if (this.fd === undefined) {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            this.fd = fs.openSync(this.file, 'a');
        }
        fs.writeSync(this.fd, record);
        this.meta.bytes += record.length;
        ++this.meta.chunks;
    }
    close() {
        if (this.fd !== undefined) {
            fs.closeSync(this.fd);
            this.fd = undefined;
        }
    }
}
export class Recorder {
    db;
    shard;
    config;
    recording;
    stats = { ticks: 0, skipped: 0, frames: 0, bytes: 0, msTotal: 0, rooms: 0, lastTick: -1 };
    world;
    rooms = new Map();
    users = new Map();
    usersRefreshed = -Infinity;
    pending;
    busy = false;
    stopped = false;
    unlisten;
    constructor(db, shard, config) {
        this.db = db;
        this.shard = shard;
        this.config = config;
        const name = config.name ?? new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const dir = path.resolve(config.dir, name);
        const existing = Recording.open(dir);
        const meta = existing?.meta ?? {
            version: 1,
            name,
            shard: shard.name,
            created: Date.now(),
            chunkTicks: config.chunkTicks,
            codec: config.codec,
            firstTick: -1,
            lastTick: -1,
            users: {},
            rooms: {},
        };
        // Resuming an old recording keeps its geometry
        this.config = { ...config, chunkTicks: meta.chunkTicks, codec: meta.codec };
        this.recording = existing ?? new Recording(dir, meta);
        for (const [room, roomMeta] of Object.entries(meta.rooms)) {
            this.rooms.set(room, new RoomRecorder(room, roomMeta, this.recording.roomFile(room)));
        }
    }
    async start() {
        this.world = await this.shard.loadWorld();
        await this.refreshUsers(this.shard.time);
        this.recording.meta.events ??= [];
        // The whole world's terrain, for the world view's backdrop
        const terrainFile = path.join(this.recording.dir, 'terrain.bin');
        if (!fs.existsSync(terrainFile)) {
            writeTerrainBin(terrainFile, this.world, await this.shard.data.smembers('rooms'));
        }
        this.recording.saveMeta();
        this.unlisten = this.shard.channel.listen(message => {
            if (message.type === 'tick') {
                this.pending = message.time;
                this.kick();
            }
        });
        if (this.config.log) {
            console.log(`replay: recording to ${this.recording.dir} (chunks of ${this.config.chunkTicks} ticks, ${this.config.codec})`);
        }
    }
    stop() {
        this.stopped = true;
        this.unlisten?.();
        for (const [name, room] of this.rooms) {
            finishEventScan(name, room.scan, this.recording.meta.events ??= []);
        }
        this.flush();
        for (const room of this.rooms.values()) {
            room.close();
        }
    }
    /** Closes every open chunk so what is on disk is complete up to now. */
    flush() {
        for (const room of this.rooms.values()) {
            this.closeChunk(room);
        }
        this.recording.saveMeta();
    }
    /** Frames held in memory for a room's current chunk. */
    liveFrames(room, chunkIndex) {
        const recorder = this.rooms.get(room);
        return recorder && recorder.chunkIndex === chunkIndex ? recorder.live : [];
    }
    kick() {
        if (this.busy || this.stopped) {
            return;
        }
        this.busy = true;
        (async () => {
            while (this.pending !== undefined && !this.stopped) {
                const tick = this.pending;
                this.pending = undefined;
                try {
                    await this.recordTick(tick);
                }
                catch (err) {
                    console.error(`replay: tick ${tick} failed`, err);
                }
            }
        })().finally(() => {
            this.busy = false;
        }).catch(console.error);
    }
    async refreshUsers(time) {
        this.usersRefreshed = time;
        // `users` may name players by id or by username (ids change with every
        // world import, usernames do not); unknown names are simply not there yet
        const ids = this.config.users
            ? (await Promise.all(this.config.users.map(async (user) => /^[0-9a-f]{6,}$/.test(user) ? user : await User.findUserByName(this.db, user)))).filter((id) => typeof id === 'string')
            : (await this.db.data.smembers('users')).filter(id => !isSystemUser(id));
        const users = new Map();
        await Promise.all(ids.map(async (id) => {
            const info = await this.db.data.hmget(User.infoKey(id), ['badge', 'username']);
            if (info.username) {
                users.set(id, {
                    username: info.username,
                    badge: info.badge ? JSON.parse(info.badge) : {},
                });
            }
        }));
        this.users = users;
        const { meta } = this.recording;
        for (const [id, info] of users) {
            // A badge file for the name replaces whatever the database has, so
            // a private-server user can wear a badge without an API call
            const fromFile = badgeFromFile(this.config.badges, info.username);
            if (fromFile !== undefined && JSON.stringify(fromFile) !== JSON.stringify(info.badge)) {
                await this.db.data.hset(User.infoKey(id), 'badge', JSON.stringify(fromFile));
                info.badge = fromFile;
                if (this.config.log) {
                    console.log(`replay: badge for ${info.username} taken from ${this.config.badges}`);
                }
            }
            meta.users[id] = info;
        }
    }
    async roomNames() {
        if (this.config.rooms) {
            return this.config.rooms;
        }
        const sets = await Promise.all([...this.users.keys()].map(id => this.shard.scratch.smembers(userToPresenceRoomsSetKey(id))));
        return [...new Set(sets.flat())].sort();
    }
    async recordTick(time) {
        const started = Date.now();
        if (this.stats.lastTick >= 0 && time > this.stats.lastTick + 1) {
            this.stats.skipped += time - this.stats.lastTick - 1;
        }
        // Players register after the server is up (the bench does), and a room
        // only counts from the tick its spawn lands: a slow refresh here missed
        // the first creeps of every run. Every tick until the expected players
        // are known, then every few ticks - a handful of keyval reads.
        const expected = this.config.users?.length;
        const complete = expected === undefined ? this.users.size > 0 : this.users.size >= expected;
        if (!complete || time - this.usersRefreshed >= 10) {
            await this.refreshUsers(time);
        }
        const names = await this.roomNames();
        const rooms = await Promise.all(names.map(async (name) => {
            try {
                return await this.shard.loadRoom(name, time);
            }
            catch (err) {
                // The tick moved on twice before we got here; that tick is a gap
                console.warn(`replay: could not load ${name}@${time}: ${err.message}`);
                return undefined;
            }
        }));
        const asUser = this.config.asUser ?? (this.users.size === 1 ? [...this.users.keys()][0] : '0');
        for (let ii = 0; ii < names.length; ++ii) {
            const room = rooms[ii];
            if (room) {
                this.record(names[ii], room, time, asUser);
            }
        }
        const { meta } = this.recording;
        if (meta.firstTick < 0) {
            meta.firstTick = time;
        }
        meta.lastTick = time;
        this.stats.ticks++;
        this.stats.lastTick = time;
        this.stats.rooms = names.length;
        this.stats.msTotal += Date.now() - started;
        if (this.config.log && time % 1000 === 0) {
            const { stats } = this;
            console.log(`replay: t=${time} rooms=${names.length} frames=${stats.frames} bytes=${stats.bytes} skipped=${stats.skipped} avg=${(stats.msTotal / Math.max(1, stats.ticks)).toFixed(2)}ms/tick`);
        }
    }
    record(name, room, time, asUser) {
        let recorder = this.rooms.get(name);
        if (recorder === undefined) {
            // Terrain lives in terrain.bin, written at start for the whole world
            const meta = { firstTick: time, lastTick: time, chunks: 0, frames: 0, bytes: 0 };
            this.recording.meta.rooms[name] = meta;
            recorder = new RoomRecorder(name, meta, this.recording.roomFile(name));
            this.rooms.set(name, recorder);
        }
        const objects = this.render(room, time, recorder.lastTick, asUser);
        scanFrameEvents(name, { tick: time, objects }, recorder.scan, this.recording.meta.events ??= []);
        if (recorder.scan.owner !== undefined) {
            recorder.meta.controller = { user: recorder.scan.owner, level: recorder.scan.level ?? 0 };
        }
        const chunkIndex = Math.floor(time / this.config.chunkTicks);
        if (recorder.encoder && recorder.chunkIndex !== chunkIndex) {
            this.closeChunk(recorder);
        }
        if (recorder.encoder === undefined) {
            recorder.encoder = new ChunkEncoder();
            recorder.chunkIndex = chunkIndex;
            recorder.live = [];
        }
        recorder.encoder.addFrame(time, objects);
        recorder.live.push({ tick: time, objects });
        recorder.lastTick = time;
        recorder.meta.lastTick = time;
        ++recorder.meta.frames;
        ++this.stats.frames;
    }
    render(room, time, previousTime, asUser) {
        return runOneShot(this.world, room, time, asUser, () => {
            const objects = new Map();
            for (const object of room['#objects']) {
                const value = object[Render](previousTime);
                if (value?._id) {
                    objects.set(value._id, value);
                }
            }
            return objects;
        });
    }
    closeChunk(recorder) {
        const { encoder } = recorder;
        if (encoder === undefined || encoder.empty) {
            return;
        }
        const raw = encoder.finish();
        const record = encodeRecord(raw, this.config.codec, encoder.firstTick, encoder.lastTick, encoder.frameCount, this.config.level);
        recorder.append(record);
        this.stats.bytes += record.length;
        recorder.encoder = undefined;
        recorder.live = [];
        this.recording.invalidate(recorder.name);
        this.recording.saveMeta();
    }
}
//# sourceMappingURL=recorder.js.map