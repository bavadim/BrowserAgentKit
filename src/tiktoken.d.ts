declare module "tiktoken" {
	export function encoding_for_model(model: string): { encode: (text: string) => number[] };
	export function get_encoding(name: string): { encode: (text: string) => number[] };
}
