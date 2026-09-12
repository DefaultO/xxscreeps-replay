# xxscreeps-replay

A server mod for [xxscreeps](https://github.com/laverdet/xxscreeps) that
records the rooms players are in, every tick, and plays them back:

- in the **official client's history mode** (the timeline UI screeps.com uses
  for room history), for any room of any recording, even after the world it
  came from is gone;
- on a **world map with a playback bar** (the
  [shardreplay](https://github.com/DefaultO/shardreplay) viewer, served over
  the recording).

Made to study speedruns: a full run to RCL5 (19,000 ticks, nine rooms) is
2.4 MB on disk.

![replays index](docs/index.png)

## Install

In the directory that holds your server's `.screepsrc.yaml`:

```sh
npm install github:DefaultO/xxscreeps-replay
```

Then list the mod, and the official client, in `.screepsrc.yaml`:

```yaml
mods:
  - xxscreeps/mods/classic
  - xxscreeps/mods/backend/cookie
  - xxscreeps/mods/backend/password
  - xxscreeps-replay
  - '@xxscreeps/client'      # the viewer is the official client; see its README

replay:
  dir: ./replays             # one sub-directory per recording
  users: [YourName]          # players (names or ids) whose rooms are recorded;
                             # default: every player, the stock NPC bots included
```

Restart the server. It logs `replay: recording to <dir>/<name>` and
`http://<host>/replay/` lists the recordings.

The mod needs Node 24 or later (it uses Node's zstd). It works in the
single-threaded launcher and the multi-threaded one alike; recording happens
in the backend process, the processor is untouched.

## Use

Open `http://<host>/replay/`. Each recording shows its rooms as map tiles on
their world coordinates, the player, the controller levels reached (each one a
link to the tick it landed), and two buttons:

- **World map** — the whole recording on a map with a full-width timeline.
  Space plays, arrows step, `+`/`-` change the speed, `/` searches a room.
  Needs `replay.viewer` (below).
- **Room …** — the official client's history view of the main room. Its
  slider is bounded to the room's recorded ticks and steps single ticks; the
  play button, speed and rewind work as on screeps.com.

Every room link carries `&code=<recording>~<room>`. That is the client's own
shared-replay mode; the link works in any browser that can reach the server.

Recording is automatic: every room some player has presence in (creeps or
structures) is recorded from the tick that presence begins — the spawn
landing, the first creep spawning. Rooms nobody is in are skipped; the engine
can reproduce them from terrain alone.

### Naming recordings

A recording is named after the time it started unless you say otherwise:

| | |
|---|---|
| `replay.name` in the config | fixed name |
| `XX_REPLAY_NAME=run-42` in the server's environment | per start, for launchers |
| `XX_REPLAY=0` | do not record at all (a server started just to view) |
| `XX_REPLAY_DIR`, `XX_REPLAY_VIEWER` | override `dir` and `viewer` |

A server killed hard loses at most the chunk it was writing (200 ticks).
`POST /replay/flush` closes the open chunks first — and saves the world
stores, which the engine otherwise only does on its own schedule — so a
launcher can do

```sh
curl -X POST http://127.0.0.1:21025/replay/flush && kill <pid>
```

`GET /replay/status` reports frames, bytes and skipped ticks of the current
recording.

### The world map viewer

Clone [shardreplay](https://github.com/DefaultO/shardreplay) and point the
mod at its `web` directory:

```yaml
replay:
  viewer: ../shardreplay/web
```

The page is served unmodified at `/replay/<name>/map/`; the mod answers the
archive API it speaks (`api/span`, `archive/index.json`,
`archive/<room>/<base>.json`, `archive/batch`, `archive/snapshot`,
`api/activity`, `api/season`, `badge/<id>.svg`, `terrain.bin`) from the
recording. Season standings and reactors do not exist in a recording and
answer 503, which the page reads as "not computed".

### Badges

A recording keeps each player's badge. Custom badges (the persistent
world's two-path kind, which xxscreeps' own badge route rejects) are drawn
by the mod for both viewers. `POST /replay/badge` with `{"badge": {...}}`,
signed in, stores any badge for the current user — e.g. the one
`https://screeps.com/api/user/find?username=<you>` returns.

### Configuration

```yaml
replay:
  enabled: true          # record at all
  dir: ./replays         # one sub-directory per recording
  name: run-42           # recording name (default: the start time)
  chunkTicks: 200        # ticks per stored chunk; keyframe every chunk
  historyChunkSize: 100  # ticks per room-history request; divides chunkTicks
  codec: zstd            # zstd | brotli | none
  level: 19              # codec level
  rooms: [W7N3]          # fixed room list (default: every room a player is in)
  users: [YourName]      # players (names or ids) whose presence picks the rooms
  asUser: abc123         # render as this user (private says); default: the only player
  log: true              # a progress line every 1000 ticks
  viewer: ../shardreplay/web   # the world map page
```

### The command line

```sh
npx xrr info    replays/run-42           # rooms, ticks, sizes, bytes per tick
npx xrr dump    replays/run-42 W7N3 1500 # the room at one tick, as client JSON
npx xrr history replays/run-42 W7N3 1500 # a room-history window, as the client gets it
npx xrr verify  replays/run-42           # decode everything, check tick order
npx xrr keys    replays/run-42 W7N3      # which fields cost the bytes
npx xrr recode  replays/run-42 W7N3 brotli
```

## The format

Per room, `<room>.xrr` is a sequence of records: a 28-byte header (`XRRC`,
codec, first and last tick, frame count, sizes) and a compressed chunk. A
reader indexes a file by seeking over headers.

A chunk is `chunkTicks` ticks starting with a keyframe. Each frame is the
room as the official client sees it — every object rendered to the JSON the
room socket sends — flattened to `path → value`. For every numeric field the
codec keeps the last value and the last two deltas and predicts the next
value: a confirmed trend continues (a TTL counting down, a constant harvest,
a creep walking straight), anything else holds. Only non-zero residuals are
written, as `key·4+kind` varint codes and zigzag varints, then the chunk is
zstd-compressed.

Measured on a bot run to RCL5: 25 KB of client JSON per tick per room
becomes ~70 B/tick for a busy home room and 5–25 B/tick elsewhere; 165 B
per game tick across all rooms of a 13-room recording; 1.3–3 ms of backend
time per tick. `xrr keys` shows where the bytes go (creep `x`/`y` first).

`meta.json` holds the players, terrain and tick range per room, the
controller levels reached, ownership changes and invader raids (the
timeline's marks), so a recording directory is self-contained. `terrain.bin`
is the whole world's terrain in the viewer's layout.

## Playback protocol

The official client asks, for a replay code `X`:

| | |
|---|---|
| `GET /replay/<name>/api/seasons/replay/X` | `{ok, room, minTime, maxTime, terrain}` |
| `GET /replay/<name>/api/seasons/replay/X/<base>` | a 100-tick window: the first recorded tick whole, later ticks as diffs, `null` where nothing was recorded |
| `GET /replay/<name>/api/user/find-shared?id=` | the player, from the recording |

`/replay/<name>/…` is a frozen server over one recording: `config.js`,
`game/time`, `room-terrain` and the badge route are answered from it and
everything else (client assets, auth, socket) is forwarded to the live
server. `/room-history/<shard>/<room>/<base>.json` serves the recording in
progress to the live client's own history button.

## Develop

```sh
git clone https://github.com/DefaultO/xxscreeps-replay
cd xxscreeps-replay
npm install
npm run build      # tsc → dist/ (committed, so an install needs no build)
npm test           # round-trips a synthetic room through the codec
```

The mod resolves `xxscreeps/…` from wherever it is installed, so for
development link it into a server's `node_modules` (a junction on Windows)
rather than installing a second copy of xxscreeps next to it: the engine's
hook registries are module-level singletons, and a mod that loads its own
copy of xxscreeps registers into the wrong one.

## License

MIT
