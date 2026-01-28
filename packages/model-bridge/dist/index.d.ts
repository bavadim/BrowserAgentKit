import type { Model, ModelRequest, ModelResponse } from "@browser-agent-kit/core";
type OpenAIModelOptions = {
    baseUrl: string;
    key?: string;
    model: string;
    headers?: Record<string, string>;
};
export declare class OpenAIModel implements Model {
    private baseUrl;
    private key?;
    private model;
    private headers?;
    constructor(options: OpenAIModelOptions);
    generate(req: ModelRequest): Promise<ModelResponse>;
}
export {};
//# sourceMappingURL=index.d.ts.map