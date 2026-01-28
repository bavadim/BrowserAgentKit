export type BrowserRuntimeOptions = {
    window?: Window;
    document?: Document;
    localStorage?: Storage;
    fetch?: typeof fetch;
    viewRoot?: Element;
};
export declare class BrowserRuntime {
    window: Window;
    document: Document;
    localStorage: Storage;
    fetch: typeof fetch;
    viewRoot?: Element;
    constructor(options?: BrowserRuntimeOptions);
}
//# sourceMappingURL=index.d.ts.map