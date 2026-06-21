#!/usr/bin/env node
import { cp, mkdir } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const source = path.join(root, "src", "browser");
const target = path.join(root, "dist", "src", "browser");

await mkdir(path.dirname(target), { recursive: true });
await cp(source, target, { recursive: true });

