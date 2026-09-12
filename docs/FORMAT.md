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

The whole world's terrain in one file, in the layout the shardreplay
viewer reads:

- A square grid of `dim x dim` rooms centred on the origin, with
  `tl = -floor(dim / 2)`. Room `(wx, wy)` starts at byte
  `((wy - tl) * dim + (wx - tl)) * 625`. Room names follow the game: `W0` is
  `wx = -1`, `E0` is `wx = 0`, `N0` is `wy = -1`, `S0` is `wy = 0`.
- A room is 625 bytes: 2500 tiles in row-major order (y outer, x inner),
  2 bits each, four tiles a byte, the first tile in the low bits.
  0 plain, 1 wall, 2 swamp, 3 wall and swamp (drawn as wall).
- `dim` is not stored: `dim = sqrt(size / 625)`.
- Rooms the world does not have are solid wall, every byte `0x55`.

The recorder writes it once at start for every room of the world. It is
the only copy of the terrain in a recording; `meta.json` carried a per-room
string in early versions and readers still accept that.

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
