"use strict";

const {createHash, randomBytes} = require("node:crypto");
const {mkdirSync, readFileSync, writeFileSync} = require("node:fs");
const {createServer} = require("node:http");
const {join, resolve} = require("node:path");
const {parseArgs} = require("node:util");
const {openStore, RequestError, roles} = require("./store.cjs");

const root = resolve(__dirname, "..");
const files = new Map([
  ["/", [join(__dirname, "workbench.html"), "text/html; charset=utf-8"]],
  ["/workbench.js", [join(__dirname, "workbench.js"), "text/javascript; charset=utf-8"]],
  ["/workbench.css", [join(__dirname, "workbench.css"), "text/css; charset=utf-8"]],
  ["/common.css", [join(root, "visualization/styles.css"), "text/css; charset=utf-8"]]
]);
const digest = token => createHash("sha256").update(token).digest("hex");

function loadCredentials(file) {
  try {
    const example = Object.keys(roles).map(role => ({
      id:`demo.${role}`, role, token:randomBytes(32).toString("hex")
    }));
    writeFileSync(file, JSON.stringify(example, null, 2) + "\n", {flag:"wx", mode:0o600});
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  return JSON.parse(readFileSync(file, "utf8"));
}

function startServer(store, credentials) {
  const principals = new Map();
  const ids = new Set();
  for (const {id, role, token} of credentials) {
    if (typeof id !== "string" || !/^[A-Za-z0-9._-]{1,80}$/.test(id) || ids.has(id) ||
        !Object.hasOwn(roles, role) || typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token) ||
        principals.has(digest(token))) {
      throw new Error("本地演示凭据配置无效。");
    }
    ids.add(id);
    principals.set(digest(token), {id, role});
  }

  function authenticate(req) {
    const token = /^Bearer ([0-9a-f]{64})$/.exec(req.headers.authorization ?? "")?.[1];
    const principal = token && principals.get(digest(token));
    if (!principal) throw new RequestError(401, "UNAUTHENTICATED", "请输入有效的本地演示密钥。");
    return principal;
  }

  function json(res, status, data) {
    res.writeHead(status, {"Content-Type":"application/json; charset=utf-8"});
    res.end(JSON.stringify(data));
  }

  async function command(req) {
    if (req.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") {
      throw new RequestError(415, "CONTENT_TYPE", "动作请求须使用 application/json。");
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 8192) throw new RequestError(413, "BODY_TOO_LARGE", "请求体过大。");
      chunks.push(chunk);
    }
    let value;
    try {
      value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new RequestError(400, "INVALID_JSON", "请求体应为有效的 JSON。");
    }
    if (value === null || Array.isArray(value) || typeof value !== "object") {
      throw new RequestError(400, "INVALID_COMMAND", "动作请求应为 JSON 对象。");
    }
    return value;
  }

  return createServer({requestTimeout:15_000, headersTimeout:10_000}, async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    try {
      const path = new URL(req.url, "http://127.0.0.1").pathname;
      const asset = files.get(path);
      if (asset && req.method === "GET") {
        const [filename, contentType] = asset;
        res.setHeader("Content-Type", contentType);
        res.end(readFileSync(filename));
        return;
      }
      if (path.startsWith("/api/")) {
        const principal = authenticate(req);
        if (path === "/api/cases" && req.method === "GET") {
          json(res, 200, {viewer:principal, ...store.summary()});
          return;
        }
        const match = /^\/api\/cases\/([A-Z0-9-]+)(\/actions)?$/.exec(path);
        if (match && !match[2] && req.method === "GET") {
          json(res, 200, store.detail(match[1], principal));
          return;
        }
        if (match?.[2] && req.method === "POST") {
          json(res, 200, store.apply(match[1], principal, await command(req)));
          return;
        }
      }
      throw new RequestError(404, "NOT_FOUND", "未找到该页面或接口。");
    } catch (error) {
      if (error instanceof RequestError) {
        json(res, error.status, {code:error.code, message:error.message});
      } else {
        console.error(error);
        json(res, 500, {code:"INTERNAL_ERROR", message:"服务无法完成该操作。"});
      }
    }
  });
}

function main() {
  const {values} = parseArgs({options:{
    port:{type:"string", default:"8766"},
    runtime:{type:"string", default:join(root, ".runtime")},
    snapshot:{type:"string", default:join(root, "model/industrial/replay.json")}
  }});
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("端口须为 1–65535。");
  const folder = resolve(values.runtime);
  mkdirSync(folder, {recursive:true, mode:0o700});
  const file = join(folder, "demo-credentials.json");
  const snapshot = JSON.parse(readFileSync(values.snapshot, "utf8"));
  const credentials = loadCredentials(file);
  const store = openStore(join(folder, "maintenance.sqlite"), snapshot);
  const server = startServer(store, credentials);
  server.on("close", () => store.close());
  server.on("error", error => {
    console.error(error.message);
    store.close();
    process.exitCode = 1;
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`液压站服务端工作台 http://127.0.0.1:${port}/`);
    console.log(`角色密钥文件 ${file}`);
  });
}

if (require.main === module) main();
module.exports = {startServer, loadCredentials};
