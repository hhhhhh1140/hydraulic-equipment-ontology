"use strict";

const {createHash} = require("node:crypto");
const {DatabaseSync} = require("node:sqlite");
const flow = require("../visualization/pilot-flow.js");

const roles = {
  engineer: new Set(["confirm", "draft", "retest", "close"]),
  supervisor: new Set(["approve"]),
  technician: new Set(["maintain"])
};

class RequestError extends Error {
  constructor(status, code, message) {
    super(message);
    Object.assign(this, {status, code});
  }
}

function openStore(filename, snapshot) {
  const db = new DatabaseSync(filename);
  const cases = new Map(snapshot.cases.map(item => [item.id, item]));
  const snapshotHash = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
  try {
    db.exec(`
      PRAGMA busy_timeout = 3000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS metadata (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        snapshot_hash TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS work_order_event (
        case_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision > 0),
        request_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        actor_role TEXT NOT NULL,
        action TEXT NOT NULL,
        retest_id TEXT,
        resulting_stage TEXT NOT NULL,
        order_id TEXT,
        rule_version TEXT NOT NULL,
        display_label TEXT NOT NULL,
        scenario_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        PRIMARY KEY (case_id, revision),
        UNIQUE (case_id, request_id)
      ) STRICT;
    `);
    db.prepare("INSERT OR IGNORE INTO metadata VALUES (1, ?)").run(snapshotHash);
    if (db.prepare("SELECT snapshot_hash FROM metadata WHERE id = 1").get().snapshot_hash !== snapshotHash) {
      throw new Error("数据库属于另一份回放数据，请为新快照使用独立的运行目录。");
    }
  } catch (error) {
    db.close();
    throw error;
  }

  const listEvents = db.prepare("SELECT * FROM work_order_event WHERE case_id = ? ORDER BY revision");
  const insertEvent = db.prepare(`
    INSERT INTO work_order_event (
      case_id, revision, request_id, actor_id, actor_role, action, retest_id, resulting_stage,
      order_id, rule_version, display_label, scenario_at, recorded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  function findCase(id) {
    const item = cases.get(id);
    if (!item) throw new RequestError(404, "CASE_NOT_FOUND", "未找到该回放案例。");
    return item;
  }

  function compose(item, events, principal) {
    const seed = flow.initial(item);
    const latest = events.at(-1);
    const state = {stage:latest?.resulting_stage ?? seed.stage, order:latest?.order_id ?? seed.order,
      events:[...seed.events, ...events.map(event => ({
        at:event.scenario_at, label:event.display_label, actor:event.actor_id
      }))]};
    const next = Object.entries(flow.schedule).find(([, step]) => step.from === state.stage);
    const canProceed = state.stage !== "review" || flow.canConfirm(item, snapshot.rule);
    const retests = state.stage === "maintained" ? item.retests.filter(test =>
      Date.parse(test.at) > Date.parse(state.events.at(-1).at)) : [];
    const available = next && canProceed && (next[0] !== "retest" || retests.length > 0);
    return {
      case:item,
      stage:state.stage,
      stageLabel:flow.stages[state.stage],
      order:state.order,
      revision:latest?.revision ?? 0,
      next:available ? {
        action:next[0], label:next[1].label,
        role:Object.keys(roles).find(role => roles[role].has(next[0])),
        allowed:roles[principal.role].has(next[0]), retests
      } : null,
      audit:[
        ...seed.events.map(event => ({scenarioAt:event.at, actor:event.actor, label:event.label, source:"seed"})),
        ...events.map(event => ({
          revision:event.revision, requestId:event.request_id, actor:event.actor_id, role:event.actor_role,
          action:event.action, retest:event.retest_id, stage:event.resulting_stage, ruleVersion:event.rule_version,
          scenarioAt:event.scenario_at, recordedAt:event.recorded_at, label:event.display_label, source:"service"
        }))
      ],
      state
    };
  }

  function publicDetail(detail) {
    const {state, ...response} = detail;
    return response;
  }

  function apply(id, principal, command, recordedAt = new Date().toISOString()) {
    const item = findCase(id);
    const {action, retest, revision, requestId} = command;
    if (!Object.hasOwn(flow.schedule, action) || !Number.isSafeInteger(revision) || revision < 0 ||
        typeof requestId !== "string" || !/^[A-Za-z0-9_-]{8,80}$/.test(requestId) ||
        (action === "retest" ? typeof retest !== "string" || !/^[A-Z0-9-]{1,80}$/.test(retest) : retest !== undefined)) {
      throw new RequestError(400, "INVALID_COMMAND", "动作、版本、请求 ID 或复测记录格式不正确。");
    }
    if (!roles[principal.role].has(action)) {
      throw new RequestError(403, "ROLE_FORBIDDEN", "当前角色无权执行该动作。");
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      const events = listEvents.all(id);
      const current = compose(item, events, principal);
      const previous = events.find(event => event.request_id === requestId);
      let response;
      if (previous) {
        if (previous.actor_id !== principal.id || previous.actor_role !== principal.role ||
            previous.action !== action || previous.retest_id !== (retest ?? null) ||
            previous.revision !== revision + 1) {
          throw new RequestError(409, "REQUEST_ID_CONFLICT", "请求 ID 已用于另一项操作。");
        }
        response = {idempotent: true, detail: publicDetail(current)};
      } else {
        if (current.revision !== revision) {
          throw new RequestError(409, "REVISION_CONFLICT", "记录已变化，请刷新工单后再操作。");
        }
        let next;
        try {
          next = flow.transition(item, snapshot.rule, current.state, {action, retest});
        } catch (error) {
          throw new RequestError(409, "TRANSITION_INVALID", error.message);
        }
        const event = next.events.at(-1);
        insertEvent.run(id, revision + 1, requestId, principal.id, principal.role, action, retest ?? null,
          next.stage, next.order, snapshot.rule.version, event.label, event.at, recordedAt);
        response = {idempotent: false, detail: publicDetail(compose(item, listEvents.all(id), principal))};
      }
      db.exec("COMMIT");
      return response;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  return {
    summary: () => ({plant:snapshot.plant, position:snapshot.position, rule:snapshot.rule, source:snapshot.source,
      cases:[...cases.values()].map(item => ({id:item.id, label:item.label}))}),
    detail: (id, principal) => publicDetail(compose(findCase(id), listEvents.all(id), principal)),
    apply,
    close: () => db.close()
  };
}

module.exports = {openStore, RequestError, roles};
