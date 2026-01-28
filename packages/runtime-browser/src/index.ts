export type BrowserRuntimeOptions = {
  window?: Window;
  document?: Document;
  localStorage?: Storage;
  fetch?: typeof fetch;
  viewRoot?: Element;
};

export class BrowserRuntime {
  window: Window;
  document: Document;
  localStorage: Storage;
  fetch: typeof fetch;
  viewRoot?: Element;

  constructor(options: BrowserRuntimeOptions = {}) {
    this.window = options.window ?? window;
    this.document = options.document ?? options.viewRoot?.ownerDocument ?? document;
    this.localStorage = options.localStorage ?? localStorage;
    this.fetch = options.fetch ?? fetch;
    this.viewRoot = options.viewRoot;
  }
}
