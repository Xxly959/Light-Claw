import { getHeapStatistics, getHeapSpaceStatistics } from "node:v8";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
global.gc(); global.gc();
await new Promise((resolve) => setTimeout(resolve, 200));
global.gc();
console.log(JSON.stringify({subject:"tsx-empty",exports:0,node:process.version,memory:process.memoryUsage(),heap:getHeapStatistics(),spaces:getHeapSpaceStatistics(),commonJsModules:Object.keys(require.cache).length}));
