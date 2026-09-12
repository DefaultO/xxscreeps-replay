// Badges as the client draws them. xxscreeps' own badge route only knows
// users in the live database and only the 24 stock shapes; a recording keeps
// each player's badge object in meta.json, and a persistent-world badge is
// usually a custom one (`type` carries its two paths), so those are drawn
// here, in the markup the client expects from `/api/user/badge-svg`.

export interface CustomBadge {
	type: { path1: string; path2: string };
	color1: string;
	color2: string;
	color3: string;
}

export function isCustomBadge(badge: unknown): badge is CustomBadge {
	if (!badge || typeof badge !== 'object') {
		return false;
	}
	const { type, color1, color2, color3 } = badge as Record<string, unknown>;
	return typeof color1 === 'string' && typeof color2 === 'string' && typeof color3 === 'string' &&
		!!type && typeof type === 'object' && typeof (type as Record<string, unknown>).path1 === 'string';
}

const safeColor = (color: string) => /^#[0-9a-fA-F]{3,8}$/.test(color) ? color : '#888888';
const safePath = (path: string) => path.replace(/[<>"&]/g, '');

export function customBadgeSvg(badge: CustomBadge, border = false): string {
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
export function plainBadgeSvg(seed: string): string {
	let hash = 0;
	for (const char of seed) {
		hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
	}
	const hue = hash % 360;
	return `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50" fill="hsl(${hue},45%,35%)"/><circle cx="50" cy="50" r="24" fill="hsl(${hue},55%,60%)"/></svg>`;
}

/** Loose check for a badge a player may store: the stock shape or a custom one. */
export function isStorableBadge(badge: unknown): boolean {
	if (!badge || typeof badge !== 'object') {
		return false;
	}
	const { type, color1, color2, color3 } = badge as Record<string, unknown>;
	const colors = [ color1, color2, color3 ].every(color => typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color));
	return colors && ((typeof type === 'number' && type >= 1 && type <= 24) || isCustomBadge(badge));
}
