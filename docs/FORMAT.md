# The recording format

Everything is little-endian. Varints are unsigned LEB128 (7 bits a byte,
high bit set on every byte but the last), up to 2^53. Zigzag maps a signed
value to a varint: `v >= 0 ? 2v : -2v - 1`. Strings are a varint byte length
followed by UTF-8.

A recording is a directory, or the same entries packed into one bundle
file:

| entry | |
|---|---|
| `meta.json` | players, rooms, tick ranges, timeline events (below) |
| `terrain.bin` | the world's terrain (below) |
| `<room>.xrr` | one file per recorded room: a sequence of records |

## Records

A room file is a sequence of records with no file header. Each record is a
28-byte header followed by one compressed chunk:

| offset | size | |
|---|---|---|
| 0 | 4 | magic `XRRC` |
| 4 | 1 | record version, 1 |
| 5 | 1 | codec: 0 none, 1 zstd, 2 brotli |
| 6 | 2 | reserved, 0 |
| 8 | 4 | first tick in the chunk |
| 12 | 4 | last tick in the chunk |
| 16 | 4 | number of frames |
| 20 | 4 | chunk length before compression |
| 24 | 4 | payload length |
| 28 | payload length | the chunk, compressed with the codec |

A reader indexes a file by reading headers and skipping payloads. A record
whose payload runs past the end of the file is a write that did not finish;
readers ignore it.

Records of one room are in tick order and never overlap. A chunk covers
ticks within one aligned span of `chunkTicks` (from `meta.json`; 200 by
default): chunk n holds ticks `[n * chunkTicks, (n + 1) * chunkTicks)`. A
span may hold more than one record when the recorder closed a chunk early
(a flush before a shutdown); every record starts with a keyframe, so they
simply concatenate.

## Chunks

A chunk is self-contained: it starts with every object of the room and
carries what a reader needs to decode it.

```
varint  format version, 1
varint  first tick
varint  last tick
varint  frame count
varint  key count,    then that many strings: the field paths used
varint  string count, then that many strings: the string values used
frames
```

Every object is flattened to `path -> value` pairs before encoding. Nested
objects become dotted paths (`store.energy`, `actionLog.harvest.x`); arrays
(`body`) stay whole as one value. An empty nested object is kept as an empty
value so it round-trips. The object's `_id` is the key it is stored under
and is not a field.

### Frames

```
varint  tick delta: 0 for the first frame, else ticks since the previous frame
varint  removed count, then that many object indexes as ascending deltas
varint  added count, then that many objects:
          string  id
          varint  field count
          entries (all absolute)
varint  changed count, then that many objects:
          varint  object index as a delta from the previous changed index
          varint  entry count
          entries
```

Objects are numbered in order of first appearance within the chunk,
starting at 0; a removed object's number is not reused. Ticks with no frame
were not recorded.

An entry is `varint code` where `code = key * 4 + kind`, `key` indexing the
key table:

| kind | | followed by |
|---|---|---|
| 0 | residual | zigzag varint, added to the predicted value |
| 1 | absolute | a value (below) |
| 2 | removed | nothing; the field is gone |

### Values

One tag byte, then:

| tag | | |
|---|---|---|
| 0 | null | |
| 1 | false | |
| 2 | true | |
| 3 | integer | zigzag varint |
| 4 | float | 8 bytes, IEEE 754 double |
| 5 | string | varint index into the string table |
| 6 | empty object | |
| 7 | array | varint length, then that many values |
| 8 | object | varint count, then that many (varint key string index, value) pairs |

### Prediction

For every integer field of every object the decoder keeps the value and
the last two deltas, `d1` (most recent) and `d2`. Before a frame's entries
apply, the field's predicted value is `value + d1` if `d1 == d2`, else
`value`. A field with no entry in a frame takes its prediction; a residual
entry adds to it; an absolute entry replaces the value and forgets both
deltas. After either, `d2 = d1` and `d1 = new - old`.

Non-integer fields (strings, booleans, floats, arrays, objects) have no
prediction: they change only through absolute entries. Integers are values
with no fractional part and magnitude at most 2^48.

The encoder does the same bookkeeping and writes an entry only where the
actual value differs from the prediction. That is the whole trick: a TTL
counting down, a source being harvested at a fixed rate, a creep walking in
a straight line, a constant field, all cost nothing after the second frame.

## Bundles

A bundle is the entries of a recording directory in one file. Nothing is
compressed again: the room entries are the room files byte for byte.

```
4 bytes  magic XRRB
1 byte   bundle version, 1
entries, each:
  1 byte   name length
  name     UTF-8
  8 bytes  entry length (unsigned 64-bit)
  bytes
```

`meta.json` comes first, then `terrain.bin`, then the rooms. A reader finds
entries by walking the headers.

## terrain.bin

The terrain of the whole world in one file, written once when a recording
starts. Objects change every tick and are recorded; terrain never changes,
so it is stored exactly once, for every room of the world, not only the
recorded ones. The layout is the one the shardreplay viewer reads, which
is why it has no header of its own: the file is nothing but room blocks in
a fixed order, and everything about it follows from its size.

### What a tile is

Screeps terrain has three states per tile, and the game encodes them as
two flag bits: `TERRAIN_MASK_WALL = 1`, `TERRAIN_MASK_SWAMP = 2`. Both set
is legal and rare; the client draws it as wall. So a tile is a value 0 to 3
and fits in two bits:

| value | bits | |
|---|---|---|
| 0 | `00` | plain |
| 1 | `01` | wall |
| 2 | `10` | swamp |
| 3 | `11` | wall and swamp, drawn as wall |

This is the same numbering the client's `room-terrain` API uses, where a
room is a string of 2500 characters `'0'`..`'3'`. A room block here is that
string, packed.

### A room block: 625 bytes

A room is 50 by 50 tiles. Tiles are numbered in row-major order, the way
the API string is written: `index = y * 50 + x`, so index 0 is the top-left
tile `(0, 0)`, index 49 is `(49, 0)` at the end of the first row, index 50
is `(0, 1)`, and index 2499 is `(49, 49)`.

Four tiles share a byte, two bits each, the lowest-numbered tile in the
low bits:

```
byte = index >> 2          (index / 4, rounded down)
shift = (index & 3) * 2    (0, 2, 4 or 6)
value = (block[byte] >> shift) & 3
```

Worked example. The first four tiles of a room are plain, wall, swamp,
plain: values 0, 1, 2, 0.

```
tile 0 → bits 0-1 → 00
tile 1 → bits 2-3 → 01
tile 2 → bits 4-5 → 10
tile 3 → bits 6-7 → 00

byte 0 = 0b 00 10 01 00 = 0x24 = 36
              ^  ^  ^  ^
              t3 t2 t1 t0
```

Reading it back: `(0x24 >> 0) & 3 = 0`, `(0x24 >> 2) & 3 = 1`,
`(0x24 >> 4) & 3 = 2`, `(0x24 >> 6) & 3 = 0`.

2500 tiles at four a byte is exactly 625 bytes, no padding. A byte of
`0x55` is `01 01 01 01`: four walls. A room block of 625 `0x55` bytes is a
room that is all wall, which is how rooms the world does not have are
written; the viewer draws them as the void beyond the map.

### Where a room sits in the file

Room names map to world coordinates the way the game does it, with the
origin between the four central rooms:

```
W0 → wx = -1        E0 → wx = 0
W1 → wx = -2        E1 → wx = 1
N0 → wy = -1        S0 → wy = 0
N1 → wy = -2        S1 → wy = 1
```

So `W7N3` is `(wx, wy) = (-8, -4)`, `E0S0` is `(0, 0)`, `W0N0` is
`(-1, -1)`.

The file is a square grid of `dim` by `dim` room blocks, laid out row by
row like the tiles inside a room: the block for grid row `r`, column `c`
starts at byte `(r * dim + c) * 625`. The grid is centred on the origin,
so its top-left room has `wx = wy = tl` with

```
tl = -floor(dim / 2)
```

and a room `(wx, wy)` is at grid row `wy - tl`, column `wx - tl`:

```
offset = ((wy - tl) * dim + (wx - tl)) * 625
```

`dim` is even (see below), so `tl = -dim / 2` and the grid covers
`wx, wy` from `-dim/2` to `dim/2 - 1` inclusive: one more room on the
west and north than on the east and south, which is what a world named
this way looks like.

`dim` is not stored. The file's size is `dim * dim * 625`, so

```
dim = sqrt(size / 625)
```

and a file whose size is not 625 times a square is not a terrain.bin.

Worked example, from the recording in the README. Its file is 360,000
bytes: `360000 / 625 = 576 = 24 * 24`, so `dim = 24` and `tl = -12`. The
grid holds `wx` and `wy` from -12 to 11, that is rooms `W11`..`E11` and
`N11`..`S11`. `W7N3` is `(-8, -4)`:

```
row    = wy - tl = -4 - (-12) = 8
column = wx - tl = -8 - (-12) = 4
offset = (8 * 24 + 4) * 625 = 196 * 625 = 122,500
```

Its block is bytes 122,500 to 123,124. The source at `(41, 3)` in that
room is tile index `3 * 50 + 41 = 191`, byte `191 >> 2 = 47` of the block,
shift `(191 & 3) * 2 = 6`: `(file[122547] >> 6) & 3`.

### How the writer picks dim

The recorder asks the world for its room list and takes the largest
absolute coordinate it sees, plus one, as the reach:

```
reach = max over rooms of max(|wx| + 1, |wy| + 1)
dim = 2 * reach
```

`|wx| + 1` rather than `|wx|` because a room at `wx = -11` needs a grid
whose `tl` is -11 or less; `2 * 11 = 22` gives `tl = -11` and fits, but
the reach counts the room itself, so it is 12 and the grid 24, one row
and column to spare. The world above is 11 by 11 rooms, `W0`..`W10` and
`N0`..`N10`, so `wx` and `wy` run from -11 to -1: `reach = 12`,
`dim = 24`, and 121 of the 576 blocks hold a room. Every block the world
has no room for is filled with `0x55` before the real rooms are written
over it.

The grid is always the smallest even square that fits; two recordings of
different worlds can therefore have different `dim`, and a reader must
derive it from the size every time rather than assume one.

### Reading it

A complete decoder, one room to the API's string form:

```js
const BYTES_PER_ROOM = 625;

function parseRoomName(name) {
  const m = /^([WE])(\d+)([NS])(\d+)$/.exec(name);
  if (!m) return null;
  return {
    wx: m[1] === 'W' ? -Number(m[2]) - 1 : Number(m[2]),
    wy: m[3] === 'N' ? -Number(m[4]) - 1 : Number(m[4]),
  };
}

function roomTerrain(file, name) {           // file: Uint8Array of terrain.bin
  const dim = Math.round(Math.sqrt(file.length / BYTES_PER_ROOM));
  if (dim * dim * BYTES_PER_ROOM !== file.length) throw new Error('not a terrain.bin');
  const pos = parseRoomName(name);
  const tl = -Math.floor(dim / 2);
  if (!pos || pos.wx < tl || pos.wy < tl || pos.wx >= tl + dim || pos.wy >= tl + dim) {
    return null;                             // outside the grid: unknown
  }
  const offset = ((pos.wy - tl) * dim + (pos.wx - tl)) * BYTES_PER_ROOM;
  let out = '';
  for (let index = 0; index < 2500; index++) {
    out += (file[offset + (index >> 2)] >> ((index & 3) * 2)) & 3;
  }
  return out;                                // 2500 characters, '0'..'3', row-major
}
```

A room inside the grid that the world never had decodes to 2500 `'1'`s.
A room outside the grid cannot be told from one that was never there, so
the decoder says unknown rather than wall.

Writing is the reverse: allocate `dim * dim * 625` bytes filled with
`0x55`, and for each room zero its block and OR each tile into place:

```js
block[index >> 2] |= (value & 3) << ((index & 3) * 2);
```

### Relation to the rest of the recording

`terrain.bin` is the only copy of the terrain in a recording. Both viewers
take room terrain from it: the client's history view through the replay
code's `terrain` field, the world map through `terrain.bin` itself. Early
recordings (before this file existed) carried a 2500-character string per
room in `meta.json`; readers still accept that and build the grid from
those strings, which then holds only the recorded rooms.

## meta.json

```jsonc
{
  "version": 1,
  "name": "rcl5",
  "shard": "shard0",
  "created": 1789219632646,      // ms since the epoch, recording start
  "updated": 1789220936408,      // last save
  "chunkTicks": 200,
  "codec": "zstd",               // the configured codec; each record says its own
  "firstTick": 1,
  "lastTick": 19201,
  "users": { "<id>": { "username": "DefaultO", "badge": { /* as the API returns it */ } } },
  "rooms": {
    "W7N3": { "firstTick": 2, "lastTick": 19201, "chunks": 97, "frames": 19200, "bytes": 1354112,
              "controller": { "user": "<id>", "level": 5 } }
  },
  "events": [                    // what the world view marks on its timeline
    { "kind": "level", "tick": 631, "room": "W7N3", "level": 2, "user": "<id>" },
    { "kind": "owner", "tick": 12, "room": "W7N4", "user": null },
    { "kind": "raid", "room": "W7N4", "from": 8104, "to": 8104, "users": ["2", "<id>"] }
  ]
}
```

`bytes` per room counts the room file's records including headers.
