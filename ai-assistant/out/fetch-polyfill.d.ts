import fetch from 'node-fetch';
export { fetch };
export interface FetchResponse {
    ok: boolean;
    status: number;
    statusText: string;
    headers: Record<string, string>;
    json(): Promise<any>;
    text(): Promise<string>;
}
//# sourceMappingURL=fetch-polyfill.d.ts.map