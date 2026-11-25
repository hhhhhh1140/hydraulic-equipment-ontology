const assert = require("node:assert/strict");
const {once} = require("node:events");
const {mkdtempSync, rmSync, readFileSync} = require("node:fs");
const {tmpdir} = require("node:os");
const {join} = require("node:path");
const {test} = require("node:test");
const {openStore} = require("../service/store.cjs");
const {startServer} = require("../service/server.cjs");

const snapshot = JSON.parse(readFileSync(join(__dirname, "../model/industrial/replay.json"), "utf8"));
const identities = [
  {id:"alice", role:"engineer", token:"a".repeat(64)},
  {id:"bob", role:"supervisor", token:"b".repeat(64)},
  {id:"carol", role:"technician", token:"c".repeat(64)}
];

async function boot(filename, source = snapshot) {
  const store = openStore(filename, source);
  const server = startServer(store, identities);
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  return {server, store, base:`http://127.0.0.1:${server.address().port}`};
}

async function stop(app) {
  const closed = once(app.server, "close");
  app.server.close();
  await closed;
  app.store.close();
}

async function request(app, path, actor, body) {
  const headers = {};
  if (actor !== undefined) headers.Authorization = `Bearer ${identities[actor].token}`;
  if (body) headers["Content-Type"] = "application/json";
  const response = await fetch(app.base + path, {headers, method:body ? "POST" : "GET",
    body:body ? JSON.stringify(body) : undefined});
  return {status:response.status, data:await response.json()};
}

test("HTTP work orders enforce roles, handle duplicate and stale requests, and persist across restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "maintenance-workbench-"));
  const filename = join(directory, "database.sqlite");
  let app;
  try {
    app = await boot(filename);
    const id = "/api/cases/AL-BEFORE";
    const send = (actor, action, revision, options = {}) =>
      request(app, id + "/actions", actor, {action, revision, requestId:`req-${action}-${revision}`, ...options});
    assert.equal((await request(app, "/api/cases")).status, 401);
    assert.equal((await request(app, "/api/cases", 0)).data.viewer.role, "engineer");
    assert.equal((await request(app, id, 0)).data.case.asset, "P-100");
    assert.equal((await request(app, "/api/cases/AL-SWAP", 0)).data.case.asset, "P-200");
    assert.equal((await request(app, id + "/actions", 0, {action:"constructor", revision:0, requestId:"prototype"})).status, 400);

    for (const blocked of ["AL-UNIT", "AL-UNSTABLE", "AL-MISSING"]) {
      const response = await request(app, `/api/cases/${blocked}/actions`, 0,
        {action:"confirm", revision:0, requestId:"blocked-command"});
      assert.equal(response.data.code, "TRANSITION_INVALID");
    }

    const confirmed = await send(0, "confirm", 0, {actor:"forged"});
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.data.detail.audit.at(-1).actor, "alice");
    const retry = await send(0, "confirm", 0);
    assert.equal(retry.data.idempotent, true);
    assert.equal(retry.data.detail.revision, 1);
    assert.equal((await send(0, "confirm", 1, {requestId:"req-confirm-0"})).data.code, "REQUEST_ID_CONFLICT");

    const concurrent = await Promise.all([
      send(0, "draft", 1, {requestId:"draft-left"}),
      send(0, "draft", 1, {requestId:"draft-right"})
    ]);
    assert.deepEqual(concurrent.map(response => response.status).sort(), [200,409]);
    assert.equal(concurrent.find(response => response.status === 409).data.code, "REVISION_CONFLICT");
    assert.equal((await send(0, "approve", 2)).status, 403);
    assert.equal((await request(app, id, 0)).data.next.allowed, false);
    assert.equal((await send(1, "approve", 2)).data.detail.stage, "approved");
    assert.equal((await send(2, "maintain", 3)).data.detail.stage, "maintained");
    assert.equal((await send(0, "close", 4)).data.code, "TRANSITION_INVALID");
    const failed = await send(0, "retest", 4, {retest:"OBS-BEFORE-NO"});
    assert.equal(failed.data.detail.stage, "maintained");
    assert.match(failed.data.detail.audit.at(-1).label, /复测未通过/);
    assert.equal((await send(0, "retest", 5, {retest:"OBS-BEFORE-OK"})).data.detail.stage, "verified");
    assert.equal((await send(0, "close", 6)).data.detail.stage, "closed");

    await stop(app);
    app = null;
    app = await boot(filename);
    const restored = (await request(app, id, 0)).data;
    assert.equal(restored.stage, "closed");
    assert.equal(restored.order, "WO-AL-BEFORE");
    assert.equal(restored.revision, 7);
    assert.deepEqual(restored.audit.map(event => event.actor), ["alice","alice","bob","carol","alice","alice","alice"]);
    assert.equal(restored.audit[0].ruleVersion, "1.0");
    assert.ok(restored.audit.every(event => event.recordedAt && event.scenarioAt));

    const other = {...snapshot, asOf:"2026-11-26T00:00:00Z"};
    assert.throws(() => openStore(filename, other), /另一份回放数据/);
  } finally {
    if (app) await stop(app);
    rmSync(directory, {recursive:true, force:true});
  }
});

test("field snapshots are readable and reject every mutation without opening a SQLite file", async () => {
  const directory = mkdtempSync(join(tmpdir(), "field-workbench-"));
  const filename = join(directory, "read-only.sqlite");
  const field = {...snapshot, mode:"read-only", schemaVersion:1, batchId:"fixture",
    summary:{qualifiedAlarms:1, blockedAlarms:0, verifiedClosed:1},
    cases:[{id:"AL-NEW", label:"Field test", quality:"QUALIFIED", asset:"PUMP-B",
      orders:[{id:"WO-OK", result:"结案已核验"}], references:[], readAudit:[]}]};
  let app;
  try {
    app = await boot(filename, field);
    const path = "/api/cases/AL-NEW";
    assert.equal((await request(app, "/api/cases", 0)).data.mode, "read-only");
    const detail = (await request(app, path, 0)).data;
    assert.equal(detail.case.asset, "PUMP-B");
    assert.equal(detail.next, null);
    for (let actor = 0; actor < identities.length; actor++) {
      const attempted = await request(app, path + "/actions", actor,
        {action:"confirm", revision:0, requestId:"field-denied"});
      assert.equal(attempted.status, 403);
      assert.equal(attempted.data.code, "READ_ONLY");
    }
    assert.throws(() => readFileSync(filename), {code:"ENOENT"});
  } finally {
    if (app) await stop(app);
    rmSync(directory, {recursive:true, force:true});
  }
});
