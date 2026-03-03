/* eslint-env node */
/* global __dirname */
/* eslint-disable import/no-nodejs-modules */

import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
    resolve: {
        alias: {
            obsidian: path.resolve(__dirname, "src/test/obsidian-shim.ts"),
        },
    },
    test: {
        environment: "node",
        include: ["src/**/*.test.ts"],
        clearMocks: true,
    },
});
