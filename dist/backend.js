// Backend hooks: starts the recorder, serves recordings to the official
// client's history mode, and mounts every recording on disk as a frozen
// server under /replay/<name>/ so old runs stay watchable after the world
// they came from is gone.
//
// The client's history view (`#!/history/<shard>/<room>?t=<tick>`) fetches
// `HISTORY_URL + shard/room/<base>.json` in windows of
// `serverData.historyChunkSize` ticks: the first tick whole, the rest as
// diffs, `null` where nothing was recorded. It reads the current game time
// to bound its timeline, and looks users up by id. Both are answered here
// for the replay prefix; everything else under the prefix is forwarded to
// the live server by rewriting the path, so the stock client assets, auth
// and socket work unchanged.
//
// Two middlewares, because of ordering. Mods' middlewares run in the order
// the mods load, and `@xxscreeps/client` serves its files without calling
// the next one, so anything that must happen before it - the path rewrite
// under /replay/<name>/, our config.js, patching build.min.js on the way
// back - lives in a small middleware placed at the very front of Koa's
// stack. It needs nothing from the request but the path. Everything that
// needs the database or the signed-in user runs in the ordinary middleware
// registered where mods usually are, after authentication.
import { hooks } from 'xxscreeps/backend/index.js';
import * as User from 'xxscreeps/engine/db/user/index.js';
import { badgeSvgFromFile, customBadgeSvg, isCustomBadge, isStorableBadge, plainBadgeSvg } from './badge.js';
import { indexPage } from './index-page.js';
import { Recorder } from './recorder.js';
import { Recording } from './recording.js';
import { replayConfig } from './settings.js';
import { serveViewer } from './viewer.js';
/** The replay code the client's history view carries: `<recording>~<room>`. */
function parseCode(code) {
    const match = /^(?<name>[A-Za-z0-9_.-]+)~(?<room>[A-Z0-9]+)$/.exec(code);
    return match ? { name: match.groups.name, room: match.groups.room } : undefined;
}
const config = replayConfig();
let recorder;
const opened = new Map();
// These names under /replay/ are routes, never recordings
const CONTROL = new Set(['flush', 'status', 'badge']);
function openRecording(name) {
    if (recorder && recorder.recording.name === name) {
        return recorder.recording;
    }
    let recording = opened.get(name);
    if (recording === undefined) {
        if (!/^[A-Za-z0-9_.-]+$/.test(name) || name.endsWith('.xrr') || CONTROL.has(name)) {
            return undefined;
        }
        // A directory, or a single-file bundle of the same name
        recording = Recording.open(`${config.dir}/${name}`) ?? Recording.open(`${config.dir}/${name}.xrr`);
        if (recording) {
            opened.set(name, recording);
            while (opened.size > 4) {
                opened.delete(opened.keys().next().value);
            }
        }
    }
    return recording;
}
function clientConfig(prefix) {
    return `
var HISTORY_URL = '${prefix}/room-history/';
var API_URL = '${prefix}/api/';
var WEBSOCKET_URL = '${prefix}/socket/';
var CONFIG = {
	API_URL: API_URL,
	HISTORY_URL: HISTORY_URL,
	WEBSOCKET_URL: WEBSOCKET_URL,
	PREFIX: '',
	IS_PTR: false,
	DEBUG: false,
	XSOLLA_SANDBOX: false,
};
`;
}
function historyRoute(recording, room, base) {
    const size = config.historyChunkSize;
    const live = recorder?.recording === recording
        ? (chunkIndex) => recorder.liveFrames(room, chunkIndex)
        : undefined;
    return recording.history(room, base, size, live);
}
hooks.register('backendReady', (db, shard) => {
    if (!config.enabled) {
        return;
    }
    recorder = new Recorder(db, shard, config);
    recorder.start().catch(err => {
        console.error('replay: recorder failed to start', err);
        recorder = undefined;
    });
    for (const signal of ['SIGINT', 'SIGTERM']) {
        process.once(signal, () => recorder?.stop());
    }
});
// --- the front middleware: paths and the client's files -----------------------
const front = async (context, next) => {
    const mounted = /^\/replay\/(?<name>[^/]+)(?<rest>\/.*)?$/.exec(context.path);
    if (mounted) {
        const name = decodeURIComponent(mounted.groups.name);
        const recording = openRecording(name);
        if (recording) {
            const rest = mounted.groups.rest;
            if (rest === undefined) {
                context.redirect(`/replay/${encodeURIComponent(name)}/`);
                return;
            }
            context.state.replay = { name, recording, rest };
            if (rest === '/' || rest === '/index.html') {
                // The client's page, served by @xxscreeps/client at the root
                context.path = '/';
            }
            else if (rest === '/config.js') {
                context.type = 'text/javascript';
                context.set('Cache-Control', 'no-cache');
                context.body = clientConfig(`/replay/${encodeURIComponent(name)}`);
                return;
            }
            else if (!(rest === '/map' || rest.startsWith('/map/'))) {
                // Assets, API, history and socket paths lose the prefix; the
                // main middleware knows the recording from the state. The world
                // view keeps its path and is routed there by prefix.
                context.path = rest;
            }
        }
    }
    else if (context.path === '/config.js') {
        // The live client's config points history at this server
        context.type = 'text/javascript';
        context.set('Cache-Control', 'no-cache');
        context.body = clientConfig('');
        return;
    }
    await next();
    // Without a replay code the client bounds its history slider at the
    // game time minus 150k ticks, which on a young world is negative.
    if (context.path === '/build.min.js' && typeof context.body === 'string') {
        context.body = context.body.replace(/historyMinGameTime=Math\.floor\(\((\w+)\.time-15e4\)\/([\w.]+)\)\*([\w.]+),/, 'historyMinGameTime=Math.max(0,Math.floor(($1.time-15e4)/$2)*$3),');
    }
};
// --- the main middleware: everything that needs the server -------------------
const main = async (context, next) => {
    const mount = context.state.replay;
    let recording = mount?.recording ?? recorder?.recording;
    if (context.path === '/replay' || context.path === '/replay/') {
        context.type = 'html';
        context.set('Cache-Control', 'no-cache');
        context.body = indexPage(Recording.list(config.dir), { live: recorder?.recording, viewer: config.viewer !== undefined });
        return;
    }
    // Control routes and unknown names under /replay/
    const control = mount ? undefined : /^\/replay\/(?<name>[^/]+)(?<rest>\/.*)?$/.exec(context.path);
    if (control) {
        const name = decodeURIComponent(control.groups.name);
        if (name === 'badge' && context.method === 'POST') {
            // Store a badge as-is for the signed-in user. xxscreeps' own route
            // only accepts the stock shapes; the persistent world's custom
            // badges (two paths) are what a bench user wants to wear.
            const { userId } = context.state;
            const badge = context.request.body?.badge;
            if (!userId) {
                context.status = 401;
                context.body = { error: 'unauthorized' };
            }
            else if (!isStorableBadge(badge)) {
                context.status = 400;
                context.body = { error: 'invalid badge' };
            }
            else {
                await context.db.data.hset(User.infoKey(userId), 'badge', JSON.stringify(badge));
                context.body = { ok: 1 };
            }
            return;
        }
        if (name === 'flush' || name === 'status') {
            let saved = false;
            if (name === 'flush') {
                recorder?.flush();
                // Launchers that kill the server hard lose whatever the engine
                // has not written yet (thousands of ticks of world state on the
                // bench); flushing the stores here keeps the world as complete
                // as the recording.
                try {
                    await Promise.all([context.shard.save(), context.db.save()]);
                    saved = true;
                }
                catch (err) {
                    console.error('replay: world save failed', err);
                }
            }
            if (recorder === undefined) {
                context.body = { ok: 1, recording: null, saved };
                return;
            }
            context.body = { ok: 1, recording: recorder.recording.location, saved, ...recorder.stats };
            return;
        }
        context.status = 404;
        context.body = 'no such recording';
        return;
    }
    if (mount) {
        recording = mount.recording;
        const { rest } = mount;
        // The client's shared-replay mode: with `code=` in the history URL it
        // asks here for the bounds (and steps single ticks), then for chunks.
        const replayCode = /^\/api\/seasons\/replay\/(?<code>[^/]+)(?:\/(?<base>\d+))?$/.exec(rest);
        if (replayCode) {
            const code = parseCode(decodeURIComponent(replayCode.groups.code));
            const room = code ? recording.meta.rooms[code.room] : undefined;
            if (!code || !room) {
                context.status = 404;
                context.body = { error: 'no such replay' };
                return;
            }
            context.set('Cache-Control', 'no-cache');
            if (replayCode.groups.base === undefined) {
                context.body = {
                    ok: 1,
                    room: code.room,
                    minTime: room.firstTick,
                    maxTime: room.lastTick,
                    terrain: recording.terrain(code.room),
                };
            }
            else {
                const chunk = historyRoute(recording, code.room, Number(replayCode.groups.base));
                if (chunk) {
                    context.body = chunk;
                }
                else {
                    context.status = 404;
                    context.body = { error: 'not recorded' };
                }
            }
            return;
        }
        if (rest === '/map' || rest.startsWith('/map/')) {
            // The world view: shardreplay's page over this recording
            const handled = await serveViewer(context, recording, rest.slice('/map'.length), {
                dir: config.viewer,
                badges: config.badges,
                world: context.backend.world,
                roomNames: context.backend.accessibleRooms,
            });
            if (handled) {
                return;
            }
            // Not handled: the path was rewritten to a live route (badges)
        }
        else if (rest === '/api/game/time') {
            // Wide enough for the client's timeline to reach the last tick
            context.body = { ok: 1, time: recording.meta.lastTick + 50 + config.historyChunkSize };
            return;
        }
        else if (rest === '/api/game/room-terrain' && typeof context.query.room === 'string') {
            const terrain = recording.meta.rooms[context.query.room] ? recording.terrain(context.query.room) : undefined;
            if (terrain) {
                context.body = { ok: 1, terrain: [{ _id: context.query.room, room: context.query.room, terrain, type: 'terrain' }] };
                return;
            }
        }
        else if (rest === '/api/user/badge-svg' && typeof context.query.username === 'string') {
            // A recorded player's badge, drawn from the recording when it is a
            // custom one; the live route handles the stock shapes
            const username = context.query.username;
            const entry = Object.values(recording.meta.users).find(user => user.username === username);
            if (entry && isCustomBadge(entry.badge) && badgeSvgFromFile(config.badges, username) === undefined) {
                context.type = 'image/svg+xml';
                context.set('Cache-Control', 'public, max-age=3600');
                context.body = customBadgeSvg(entry.badge, context.query.border === '1');
                return;
            }
        }
    }
    // A badge image on disk wins over anything rendered, live or recorded
    if (context.path === '/api/user/badge-svg' && typeof context.query.username === 'string') {
        const svg = badgeSvgFromFile(config.badges, context.query.username);
        if (svg !== undefined) {
            context.type = 'image/svg+xml';
            context.set('Cache-Control', 'no-cache');
            context.body = svg;
            return;
        }
    }
    // Recorded users are answered from the recording, live ones from the db.
    // The client's history view asks `find-shared` (an official-server
    // route) by id; xxscreeps' own `find` only knows usernames.
    if ((context.path === '/api/user/find' || context.path === '/api/user/find-shared') && typeof context.query.id === 'string') {
        const id = context.query.id;
        const info = recording?.meta.users[id] ?? await async function () {
            const user = await context.db.data.hmget(User.infoKey(id), ['badge', 'username']);
            return user.username ? { username: user.username, badge: user.badge ? JSON.parse(user.badge) : {} } : undefined;
        }();
        if (info) {
            // The client's badge directive reads colors off the badge object;
            // a user who never set one gets the stock shape.
            const badge = info.badge && typeof info.badge === 'object' && 'color1' in info.badge
                ? info.badge
                : { type: 1, color1: '#4b4b4b', color2: '#ffffff', color3: '#ffffff', param: 0, flip: false };
            context.body = { ok: 1, user: { _id: id, username: info.username, badge } };
        }
        else {
            context.body = { error: 'not found' };
        }
        return;
    }
    // The history chunks themselves
    const history = /^\/room-history\/(?<shard>[^/]+)\/(?<room>[A-Z0-9]+)\/(?<tick>\d+)\.json$/.exec(context.path);
    if (history) {
        const { room, tick } = history.groups;
        const chunk = recording ? historyRoute(recording, room, Number(tick)) : undefined;
        if (chunk) {
            context.set('Cache-Control', 'no-cache');
            context.body = chunk;
        }
        else {
            context.status = 404;
            context.body = { error: 'not recorded' };
        }
        return;
    }
    await next();
    // The client sizes its history windows from the version handshake
    if (context.path === '/api/version' && typeof context.body === 'object' && context.body !== null) {
        const body = context.body;
        if (body.serverData) {
            body.serverData.historyChunkSize = config.historyChunkSize;
        }
    }
    // The room renderer loads the owner's badge through PIXI's loader and
    // draws nothing at all when that fails; users without a badge (bots
    // registered over the API, users of a recording whose world is gone)
    // get a plain one instead of a 404.
    if (context.path === '/api/user/badge-svg' && context.status === 404) {
        const username = typeof context.query.username === 'string' ? context.query.username : '';
        context.status = 200;
        context.type = 'image/svg+xml';
        context.set('Cache-Control', 'public, max-age=3600');
        context.body = plainBadgeSvg(username);
    }
};
hooks.register('middleware', koa => {
    // Ahead of every other middleware, the client's included: Koa keeps its
    // stack in a plain array and runs it in order.
    koa.middleware.unshift(front);
    koa.use(main);
});
//# sourceMappingURL=backend.js.map