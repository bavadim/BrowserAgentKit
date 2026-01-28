export class BrowserRuntime {
    constructor(options = {}) {
        this.window = options.window ?? window;
        this.document = options.document ?? options.viewRoot?.ownerDocument ?? document;
        this.localStorage = options.localStorage ?? localStorage;
        this.fetch = options.fetch ?? fetch;
        this.viewRoot = options.viewRoot;
    }
}
//# sourceMappingURL=index.js.map