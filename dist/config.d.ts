export type Codec = 'none' | 'zstd' | 'brotli';
export type Schema = {
    replay?: {
        enabled?: boolean;
        dir?: string;
        name?: string;
        chunkTicks?: number;
        historyChunkSize?: number;
        codec?: Codec;
        level?: number;
        rooms?: string[];
        users?: string[];
        asUser?: string;
        log?: boolean;
        viewer?: string;
    };
};
export declare const defaults: {
    replay: {
        enabled: boolean;
        dir: string;
        chunkTicks: number;
        historyChunkSize: number;
        codec: Codec;
        log: boolean;
    };
};
