import tsParser from "@typescript-eslint/parser";
import globals from "globals";

export default [
	{
		ignores: ["dist/**", "node_modules/**"],
	},
	{
		files: ["**/*.{js,mjs,cjs,ts}"],
		languageOptions: {
			parser: tsParser,
			ecmaVersion: 2020,
			sourceType: "module",
			globals: {
				...globals.browser,
				...globals.node,
			},
		},
		rules: {
			indent: ["error", "tab", { SwitchCase: 1 }],
			"no-tabs": "off",
			"no-mixed-spaces-and-tabs": "error",
		},
	},
];
