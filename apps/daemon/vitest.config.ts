import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 集成测试会拉起真实 agent 子进程(opencode serve / Claude Code),
    // 并行跑多个测试文件时相互抢占资源,导致偶发超时。串行执行。
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 60_000,
  },
});
