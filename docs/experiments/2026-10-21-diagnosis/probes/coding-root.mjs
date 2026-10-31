import { getHeapStatistics, getHeapSpaceStatistics } from "node:v8";
import { createRequire } from "node:module";
import * as subject0 from "/Users/x/hermes-workspace/Light-Claw/packages/coding-agent/src/index.ts";
const require = createRequire(import.meta.url);
global.gc(); global.gc();
await new Promise((resolve) => setTimeout(resolve, 200));
global.gc();
console.log(JSON.stringify({subject:"coding-root",exports:Object.keys(subject0).length,node:process.version,memory:process.memoryUsage(),heap:getHeapStatistics(),spaces:getHeapSpaceStatistics(),commonJsModules:Object.keys(require.cache).length}));
