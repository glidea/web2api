#!/usr/bin/env node

import { fileURLToPath } from "node:url";

process.env["GLIDEA_WEB2API_RUNTIME_PATH"] = fileURLToPath(new URL("../dist/glidea-web2api.cjs", import.meta.url));
await import("../dist/glidea-web2api.cjs");
