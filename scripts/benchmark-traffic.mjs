#!/usr/bin/env node
/**
 * WebSocket 传输基准：在真实 `ws` 连接上测量线速字节。
 *
 * 为什么不用 zlib 直接模拟：`permessage-deflate` 的阈值判断被 no-context-takeover
 * 参数包住（见 ws/lib/sender.js），压缩与否、帧头开销、上下文接管的实际行为都只在
 * 真实的 sender 里成立。这里起一个真的 WebSocketServer、连一个真的客户端，读服务端
 * socket 的 `bytesWritten` 增量——那是 TCP 之上、IP 之下的真实写入量，包含 WebSocket
 * framing 与压缩效果。
 *
 * 用法：
 *   node scripts/benchmark-traffic.mjs
 *   node scripts/benchmark-traffic.mjs --repeats 5 --out data/diagnostics/bench.json
 *   node scripts/benchmark-traffic.mjs --scenarios spinner,stream --configs off,stateless-1024
 *   node scripts/benchmark-traffic.mjs --memory        （额外测每连接内存，较慢）
 *
 * 输出：stdout 上的 Markdown 摘要 + 可选的原始 JSON。
 *
 * 结果只在同一台机器、同一份 fixture、同一组版本号之间可比。JSON 里带 fixture 的
 * SHA-256、Node/ws/zlib 版本和协议版本，跨机器引用时必须连同这些一起引用。
 */

import { createHash } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { WebSocket, WebSocketServer } from "ws";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// 确定性伪随机：同一 seed 必然产出同一份 fixture，否则两次运行不可比。
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (rng, list) => list[Math.floor(rng() * list.length) % list.length];

// ---------------------------------------------------------------------------
// 去敏 fixture 素材：形状取自真实终端输出，内容全部是占位符，不含本机路径、
// 提示词、代码或任何用户数据。
// ---------------------------------------------------------------------------

const PROMPT = "PS /srv/app> ";
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧"];

const LOG_LINES = [
  "npm run build",
  "> app@0.1.0 build",
  "> vite build && tsc -p tsconfig.json",
  "vite v5.4.11 building for production...",
  "transforming (142) node_modules/react-dom/cjs/react-dom.production.min.js",
  "dist/index.html                    0.48 kB | gzip:  0.31 kB",
  "dist/assets/index-a1b2c3d4.css    35.24 kB | gzip:  7.50 kB",
  "dist/assets/index-e5f6a7b8.js    769.72 kB | gzip: 221.76 kB",
  "✓ built in 3.48s",
  "PASS  src/shared/tab-window.test.ts (7 tests) 3ms",
  "PASS  src/server/traffic-ledger.test.ts (15 tests) 12ms",
  "FAIL  src/server/queue.test.ts > settles a turn",
  "  AssertionError: expected 'running' to be 'completed'",
  "    at src/server/queue.test.ts:118:24",
  "Test Files  62 passed (62)",
  "     Tests  402 passed (402)",
  "  Duration  22.43s",
];

const SGR = ["[0m", "[1m", "[32m", "[31m", "[90m", "[36m"];

const TAB_ID = "11111111-2222-4333-8444-555555555555";
const GENERATION = "66666666-7777-4888-8999-aaaaaaaaaaaa";
const STREAM_ID = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";

const styledRow = (row, runs) => ({ row, clearToEnd: true, runs });
const run = (text, fg = "default", flags = []) => ({ text, style: { fg, bg: "default", flags } });

function screenFrame(sequence, revision, rows, cursor) {
  return {
    type: "terminal.screen",
    tabId: TAB_ID,
    generation: GENERATION,
    streamId: STREAM_ID,
    sequence,
    revision,
    full: false,
    cols: 125,
    totalRows: 13,
    viewportTop: 0,
    viewportRows: 13,
    alternateScreen: false,
    sizeEpoch: 1,
    inputModes: {
      applicationCursorKeys: true,
      applicationKeypad: false,
      bracketedPaste: true,
      mouseTracking: "none",
      sendFocus: false,
    },
    cursor,
    rows,
  };
}

function rawFrame(startOffset, payload) {
  const bytes = Buffer.from(payload, "utf8");
  return {
    type: "terminal.output",
    tabId: TAB_ID,
    generation: GENERATION,
    startOffset,
    endOffset: startOffset + bytes.length,
    reset: false,
    dataBase64: bytes.toString("base64"),
  };
}

// ---------------------------------------------------------------------------
// 场景。每个场景返回一组已序列化的消息。
//
// 尺寸按 2026-08-28 的真实账本校准：
//   out:ws:terminal.output  平均 978.74 B（含快照拉高）  max 1,333,629 B
//   out:ws:terminal.screen  平均   921.35 B              max     5,136 B
//   in:ws:terminal.input    平均    93.34 B              max        96 B
// ---------------------------------------------------------------------------

const SCENARIOS = {
  /** TUI 转圈动画：每帧只有一个字符变化，帧间相似度极高。 */
  spinner(rng, count = 240) {
    const out = [];
    for (let i = 0; i < count; i += 1) {
      out.push(JSON.stringify(screenFrame(i + 1, 4000 + i, [
        styledRow(7, [run(`${SPINNER[i % SPINNER.length]} Working`, "default")]),
      ], { row: 7, col: 10, visible: true })));
    }
    return out;
  },

  /** 代理逐 token 输出：每帧重绘两行，内容持续变化。 */
  stream(rng, count = 240) {
    const out = [];
    for (let i = 0; i < count; i += 1) {
      const word = pick(rng, ["analysing", "reading", "patching", "verifying", "building", "resolving"]);
      out.push(JSON.stringify(screenFrame(i + 1, 5000 + i, [
        styledRow(5 + (i % 3), [run(PROMPT), run(`${word} module ${i}`, 10, ["bold"])]),
        styledRow(6 + (i % 3), [run(pick(rng, LOG_LINES).slice(0, 60))]),
      ], { row: 5 + (i % 3), col: 20 + (i % 40), visible: true })));
    }
    return out;
  },

  /** raw 模式的实时构建日志：重复性高的密集输出。 */
  buildLog(rng, count = 240) {
    const out = [];
    let offset = 100_000;
    for (let i = 0; i < count; i += 1) {
      const lines = [];
      for (let n = 0; n < 3 + Math.floor(rng() * 4); n += 1) {
        lines.push(`${pick(rng, SGR)}${pick(rng, LOG_LINES)}[0m\r\n`);
      }
      const payload = lines.join("");
      out.push(JSON.stringify(rawFrame(offset, payload)));
      offset += Buffer.byteLength(payload);
    }
    return out;
  },

  /** 上行按键：每次一个字符。 */
  input(rng, count = 240) {
    const out = [];
    const text = "git status --short && npm run build -- --mode production\r";
    for (let i = 0; i < count; i += 1) {
      out.push(JSON.stringify({
        type: "terminal.input",
        tabId: TAB_ID,
        dataBase64: Buffer.from(text[i % text.length], "utf8").toString("base64"),
      }));
    }
    return out;
  },

  /** 一次完整的 1 MB PTY 缓冲区重放，即账本里 1,333,629 B 那条消息。 */
  snapshot(rng) {
    const parts = [];
    let size = 0;
    while (size < 1_000_000) {
      const line = `${pick(rng, SGR)}${pick(rng, LOG_LINES)}[0m\r\n`;
      parts.push(line);
      size += Buffer.byteLength(line);
    }
    const payload = Buffer.from(parts.join(""), "utf8").subarray(0, 1_000_000).toString("utf8");
    return [JSON.stringify({ ...rawFrame(0, payload), reset: true })];
  },

  /** 按真实账本的消息比例混合，用于总量估算。 */
  mixed(rng) {
    const out = [];
    const spinner = SCENARIOS.spinner(mulberry32(11), 40);
    const stream = SCENARIOS.stream(mulberry32(22), 40);
    const build = SCENARIOS.buildLog(mulberry32(33), 160);
    // 账本比例约为 output : screen : input = 533,346 : 3,183 : 4,995
    for (let i = 0; i < 240; i += 1) {
      if (i % 60 === 0) out.push(pick(rng, spinner));
      else if (i % 37 === 0) out.push(pick(rng, stream));
      else out.push(build[i % build.length]);
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// 被测配置。名字即 CLI 里的取值。
// ---------------------------------------------------------------------------

const CONFIGS = {
  "off": false,
  "stateless-1024": deflate({ threshold: 1024 }),          // 当前生产配置
  "stateless-512": deflate({ threshold: 512 }),
  "stateless-256": deflate({ threshold: 256 }),
  "stateless-0": deflate({ threshold: 0 }),
  "server-takeover": deflate({ threshold: 1024, serverNoContextTakeover: false }),
  "server-takeover-wb13": deflate({ threshold: 1024, serverNoContextTakeover: false, serverMaxWindowBits: 13, memLevel: 6 }),
  "server-takeover-wb11": deflate({ threshold: 1024, serverNoContextTakeover: false, serverMaxWindowBits: 11, memLevel: 4 }),
};

function deflate({ threshold, serverNoContextTakeover = true, serverMaxWindowBits, memLevel = 7 }) {
  return {
    serverNoContextTakeover,
    clientNoContextTakeover: true,
    concurrencyLimit: 4,
    threshold,
    ...(serverMaxWindowBits ? { serverMaxWindowBits } : {}),
    zlibDeflateOptions: { level: 3, memLevel },
  };
}

// ---------------------------------------------------------------------------
// 一次测量：起服务器 → 连客户端 → 发完 → 等收完 → 读 socket 增量。
// ---------------------------------------------------------------------------

async function measure(perMessageDeflate, messages, { warmup }) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0, perMessageDeflate });
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();

  const sockets = [];
  server.on("connection", (socket) => sockets.push(socket));

  const openClient = async () => {
    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((resolve, reject) => {
      client.once("open", resolve);
      client.once("error", reject);
    });
    // connection 事件与 client open 之间没有顺序保证，等服务端侧就位。
    while (sockets.length === 0) await new Promise((r) => setImmediate(r));
    return { client, socket: sockets.pop() };
  };

  try {
    // 预热在一条独立连接上完成：对启用上下文接管的配置，预热若与测量共用连接，
    // 会把压缩字典先喂饱，测出来的字节数偏低。
    if (warmup > 0) {
      const { client, socket } = await openClient();
      await pump(socket, client, messages.slice(0, Math.min(warmup, messages.length)));
      client.close();
      await new Promise((r) => setTimeout(r, 20));
    }

    const { client, socket } = await openClient();
    // connection 事件给的是 WebSocket 实例；字节计数在它底下的 net socket 上。
    const wire = socket._socket;
    if (!wire || typeof wire.bytesWritten !== "number") throw new Error("no underlying socket to measure");
    const before = { wire: wire.bytesWritten, cpu: process.cpuUsage(), at: process.hrtime.bigint() };
    const received = await pump(socket, client, messages);
    const cpu = process.cpuUsage(before.cpu);
    const result = {
      messages: messages.length,
      payloadBytes: messages.reduce((total, m) => total + Buffer.byteLength(m, "utf8"), 0),
      wireBytes: wire.bytesWritten - before.wire,
      receivedBytes: received,
      cpuMs: Math.round((cpu.user + cpu.system) / 1000),
      elapsedMs: Number(process.hrtime.bigint() - before.at) / 1e6,
    };
    client.close();
    return result;
  } finally {
    for (const socket of sockets) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  }
}

/** 发完全部消息并等客户端收齐，否则 bytesWritten 会漏掉仍在缓冲里的部分。 */
function pump(socket, client, messages) {
  return new Promise((resolve, reject) => {
    let seen = 0;
    let bytes = 0;
    const onMessage = (data) => {
      seen += 1;
      bytes += data.length ?? Buffer.byteLength(String(data));
      if (seen === messages.length) {
        client.off("message", onMessage);
        // 让 socket 把最后一批写入冲刷完再读计数。
        setTimeout(() => resolve(bytes), 10);
      }
    };
    client.on("message", onMessage);
    client.once("error", reject);
    for (const message of messages) socket.send(message);
  });
}

/**
 * 每连接内存。ws 是在第一条被压缩的消息上才惰性建立 deflate 上下文的，所以每条
 * 连接都必须真的发一条足够大的消息。数字是 RSS 差除以连接数，含 socket 与 ws 对象
 * 本身，不是纯 zlib 开销；作为量级参考，不作为精确值。
 */
async function measureMemory(perMessageDeflate, connections = 50) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0, perMessageDeflate });
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  const serverSockets = [];
  server.on("connection", (socket) => serverSockets.push(socket));
  const clients = [];
  const payload = JSON.stringify(SCENARIOS.stream(mulberry32(7), 4));

  try {
    global.gc?.();
    await new Promise((r) => setTimeout(r, 50));
    const before = process.memoryUsage().rss;

    for (let i = 0; i < connections; i += 1) {
      const client = new WebSocket(`ws://127.0.0.1:${port}`);
      await new Promise((resolve, reject) => { client.once("open", resolve); client.once("error", reject); });
      clients.push(client);
      while (serverSockets.length <= i) await new Promise((r) => setImmediate(r));
      await new Promise((resolve) => serverSockets[i].send(payload, resolve));
    }
    await new Promise((r) => setTimeout(r, 100));
    global.gc?.();
    await new Promise((r) => setTimeout(r, 50));

    return Math.round((process.memoryUsage().rss - before) / connections);
  } finally {
    for (const client of clients) client.terminate();
    for (const socket of serverSockets) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  }
}

// ---------------------------------------------------------------------------
// 驱动
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { repeats: 5, warmup: 30, out: null, memory: false, scenarios: null, configs: null };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--memory") args.memory = true;
    else if (flag === "--repeats") args.repeats = Number(argv[++i]);
    else if (flag === "--warmup") args.warmup = Number(argv[++i]);
    else if (flag === "--out") args.out = argv[++i];
    else if (flag === "--scenarios") args.scenarios = argv[++i].split(",");
    else if (flag === "--configs") args.configs = argv[++i].split(",");
  }
  return args;
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
};

function environment() {
  const pkg = JSON.parse(readFileSync(join(ROOT, "node_modules", "ws", "package.json"), "utf8"));
  const protocol = readFileSync(join(ROOT, "src", "shared", "terminal-protocol.ts"), "utf8")
    .match(/TERMINAL_PROTOCOL_VERSION\s*=\s*(\d+)/);
  return {
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    ws: pkg.version,
    zlib: zlib.constants.ZLIB_VERNUM ? process.versions.zlib : "unknown",
    terminalProtocolVersion: protocol ? Number(protocol[1]) : null,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const scenarioNames = args.scenarios ?? Object.keys(SCENARIOS);
  const configNames = args.configs ?? Object.keys(CONFIGS);

  const fixtures = {};
  for (const name of scenarioNames) {
    if (!SCENARIOS[name]) throw new Error(`unknown scenario: ${name}`);
    // 固定 seed。同一 seed 两次生成必须逐字节相同，否则结果不可比。
    const once = SCENARIOS[name](mulberry32(0x5eed));
    const twice = SCENARIOS[name](mulberry32(0x5eed));
    if (once.join(" ") !== twice.join(" ")) throw new Error(`scenario ${name} is not deterministic`);
    fixtures[name] = {
      messages: once,
      sha256: createHash("sha256").update(once.join(" ")).digest("hex").slice(0, 16),
      payloadBytes: once.reduce((total, m) => total + Buffer.byteLength(m, "utf8"), 0),
    };
  }

  const results = [];
  for (const scenario of scenarioNames) {
    for (const config of configNames) {
      if (!(config in CONFIGS)) throw new Error(`unknown config: ${config}`);
      const runs = [];
      for (let i = 0; i < args.repeats; i += 1) {
        runs.push(await measure(CONFIGS[config], fixtures[scenario].messages, { warmup: args.warmup }));
      }
      const wireBytes = median(runs.map((r) => r.wireBytes));
      results.push({
        scenario,
        config,
        messages: runs[0].messages,
        payloadBytes: runs[0].payloadBytes,
        wireBytes,
        wireBytesPerMessage: Math.round(wireBytes / runs[0].messages),
        ratio: Number((runs[0].payloadBytes / wireBytes).toFixed(2)),
        cpuMs: median(runs.map((r) => r.cpuMs)),
        elapsedMs: Math.round(median(runs.map((r) => r.elapsedMs))),
      });
    }
  }

  const memory = {};
  if (args.memory) {
    for (const config of configNames) memory[config] = await measureMemory(CONFIGS[config]);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    environment: environment(),
    method: {
      measurement: "server-side socket.bytesWritten delta on a real ws connection",
      repeats: args.repeats,
      statistic: "median",
      warmupMessages: args.warmup,
      warmupConnection: "separate connection, so context-takeover configs are not pre-primed",
      note: "wireBytes 含 WebSocket framing 与压缩，不含 IP/TCP 头，也不含 TLS（本基准是明文 ws://）",
    },
    fixtures: Object.fromEntries(
      Object.entries(fixtures).map(([name, f]) => [name, { messages: f.messages.length, payloadBytes: f.payloadBytes, sha256: f.sha256 }]),
    ),
    results,
    ...(args.memory ? { rssBytesPerConnection: memory, memoryNote: global.gc ? "with --expose-gc" : "without --expose-gc, noisier" } : {}),
  };

  printSummary(report);

  if (args.out) {
    mkdirSync(dirname(join(ROOT, args.out)), { recursive: true });
    writeFileSync(join(ROOT, args.out), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(`\n原始结果: ${args.out}`);
  }
}

function printSummary(report) {
  const { environment: env, fixtures, results } = report;
  console.log(`\nNode ${env.node} · ws ${env.ws} · zlib ${env.zlib} · ${env.platform} · 终端协议 v${env.terminalProtocolVersion}`);
  console.log(`重复 ${report.method.repeats} 次取中位数，预热 ${report.method.warmupMessages} 条（独立连接）\n`);

  for (const [name, fixture] of Object.entries(fixtures)) {
    const rows = results.filter((r) => r.scenario === name);
    if (!rows.length) continue;
    const baseline = rows.find((r) => r.config === "off") ?? rows[0];
    console.log(`### ${name} — ${fixture.messages} 条消息, payload ${fixture.payloadBytes.toLocaleString()} B, fixture ${fixture.sha256}\n`);
    console.log("| 配置 | 线速字节 | 每条 | payload/线速 | 相对未压缩 | CPU ms |");
    console.log("|---|---:|---:|---:|---:|---:|");
    for (const row of rows) {
      const relative = ((row.wireBytes / baseline.wireBytes) * 100).toFixed(0);
      console.log(`| ${row.config} | ${row.wireBytes.toLocaleString()} | ${row.wireBytesPerMessage} | ${row.ratio}× | ${relative}% | ${row.cpuMs} |`);
    }
    console.log("");
  }

  if (report.rssBytesPerConnection) {
    console.log("### 每连接 RSS 增量（量级参考，非精确值）\n");
    console.log("| 配置 | 每连接 |");
    console.log("|---|---:|");
    for (const [config, bytes] of Object.entries(report.rssBytesPerConnection)) {
      console.log(`| ${config} | ${(bytes / 1024).toFixed(1)} KiB |`);
    }
    console.log("");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
