import { memoryStore } from "../mod.ts";
import { storeSuite } from "./store_suite.ts";

storeSuite("memory", () => Promise.resolve(memoryStore()));
