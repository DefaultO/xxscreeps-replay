// Badges as the client draws them. xxscreeps' own badge route only knows
// users in the live database and only the 24 stock shapes; a recording keeps
// each player's badge object in meta.json, and a persistent-world badge is
// usually a custom one (`type` carries its two paths), so those are drawn
// here, in the markup the client expects from `/api/user/badge-svg`.
export function isCustomBadge(badge) {
    if (!badge || typeof badge !== 'object') {
        return false;
    }
    const { type, color1, color2, color3 } = badge;
    return typeof color1 === 'string' && typeof color2 === 'string' && typeof color3 === 'string' &&
        !!type && typeof type === 'object' && typeof type.path1 === 'string';
}
const safeColor = (color) => /^#[0-9a-fA-F]{3,8}$/.test(color) ? color : '#888888';
const safePath = (path) => path.replace(/[<>"&]/g, '');
export function customBadgeSvg(badge, border = false) {
    const path2 = badge.type.path2 ?? '';
    return '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 100 100" shape-rendering="geometricPrecision">' +
        `<defs><clipPath id="clip"><circle cx="50" cy="50" r="${border ? 48 : 52}" /></clipPath></defs>` +
        '<g>' +
        `<rect x="0" y="0" width="100" height="100" fill="${safeColor(badge.color1)}" clip-path="url(#clip)" />` +
        `<path d="${safePath(badge.type.path1)}" fill="${safeColor(badge.color2)}" clip-path="url(#clip)" />` +
        (path2 === '' ? '' : `<path d="${safePath(path2)}" fill="${safeColor(badge.color3)}" clip-path="url(#clip)" />`) +
        (border ? '<circle cx="50" cy="50" r="47.5" fill="transparent" stroke="#000" stroke-width="5"></circle>' : '') +
        '</g></svg>';
}
/** A plain two-tone disc for players with no badge at all. */
export function plainBadgeSvg(seed) {
    let hash = 0;
    for (const char of seed) {
        hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    }
    const hue = hash % 360;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50" fill="hsl(${hue},45%,35%)"/><circle cx="50" cy="50" r="24" fill="hsl(${hue},55%,60%)"/></svg>`;
}
// --- badges from files ------------------------------------------------------
//
// `<badges dir>/<username>.json` is a badge object as the API returns it
// (`https://screeps.com/api/user/find?username=...` → `user.badge`); the
// recorder stores it for that user when it sees them, so the client draws it
// everywhere. `<username>.svg` is served as that user's badge image instead
// of the rendered one (the world map and the badge-svg route), no database
// involved.
import * as fs from 'node:fs';
import * as path from 'node:path';
const files = new Map();
function readFile(file) {
    let stat;
    try {
        stat = fs.statSync(file);
    }
    catch {
        files.delete(file);
        return null;
    }
    const cached = files.get(file);
    if (cached && cached.mtime === stat.mtimeMs) {
        return cached;
    }
    const entry = { mtime: stat.mtimeMs };
    try {
        if (file.endsWith('.json')) {
            const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
            // Either the badge itself or the whole `user/find` response
            const badge = parsed?.badge ?? parsed?.user?.badge ?? parsed;
            if (isStorableBadge(badge)) {
                entry.badge = badge;
            }
        }
        else {
            entry.svg = fs.readFileSync(file, 'utf8');
        }
    }
    catch {
        // unreadable: treated as absent until it changes
    }
    files.set(file, entry);
    return entry;
}
const safeName = (username) => /^[A-Za-z0-9_-]{1,32}$/.test(username) ? username : undefined;
/** The badge object from `<dir>/<username>.json`, if there is one. */
export function badgeFromFile(dir, username) {
    const name = dir && safeName(username);
    return name ? readFile(path.join(dir, `${name}.json`))?.badge : undefined;
}
/** The SVG from `<dir>/<username>.svg`, if there is one. */
export function badgeSvgFromFile(dir, username) {
    const name = dir && safeName(username);
    return name ? readFile(path.join(dir, `${name}.svg`))?.svg : undefined;
}
/** Loose check for a badge a player may store: the stock shape or a custom one. */
export function isStorableBadge(badge) {
    if (!badge || typeof badge !== 'object') {
        return false;
    }
    const { type, color1, color2, color3 } = badge;
    const colors = [color1, color2, color3].every(color => typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color));
    return colors && ((typeof type === 'number' && type >= 1 && type <= 24) || isCustomBadge(badge));
}
//# sourceMappingURL=badge.js.map