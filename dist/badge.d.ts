export interface CustomBadge {
    type: {
        path1: string;
        path2: string;
    };
    color1: string;
    color2: string;
    color3: string;
}
export declare function isCustomBadge(badge: unknown): badge is CustomBadge;
export declare function customBadgeSvg(badge: CustomBadge, border?: boolean): string;
/** A plain two-tone disc for players with no badge at all. */
export declare function plainBadgeSvg(seed: string): string;
/** The badge object from `<dir>/<username>.json`, if there is one. */
export declare function badgeFromFile(dir: string | undefined, username: string): unknown;
/** The SVG from `<dir>/<username>.svg`, if there is one. */
export declare function badgeSvgFromFile(dir: string | undefined, username: string): string | undefined;
/** Loose check for a badge a player may store: the stock shape or a custom one. */
export declare function isStorableBadge(badge: unknown): boolean;
