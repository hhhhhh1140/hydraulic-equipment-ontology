const {test} = require("node:test");
const assert = require("node:assert/strict");
const {readFileSync} = require("node:fs");
const {join} = require("node:path");
const {canConfirm, initial, replay, transition} = require("../visualization/pilot-flow");
const js = readFileSync(join(__dirname, "../visualization/pilot-data.js"), "utf8");
const data = JSON.parse(js.slice(js.indexOf("=") + 1, js.lastIndexOf(";")));
const cases = Object.fromEntries(data.cases.map(item => [item.id, item]));
const rule = data.rule;

test("missing, unstable or wrong-unit evidence blocks fault confirmation", () => {
  for (const id of ["AL-UNSTABLE", "AL-UNIT", "AL-MISSING"]) {
    assert.equal(canConfirm(cases[id], rule), false);
    assert.throws(() => transition(cases[id], rule, initial(cases[id]), {action:"confirm"}));
  }
});

test("the work order requires approval and a later passing retest", () => {
  const item = cases["AL-BEFORE"];
  const events = ["confirm", "draft", "approve", "maintain"].map(action => ({action}));
  assert.throws(() => replay(item, rule, [{action:"confirm"}, {action:"draft"}, {action:"maintain"}]));
  const maintained = replay(item, rule, events);
  assert.equal(maintained.stage, "maintained");
  assert.throws(() => transition(item, rule, maintained, {action:"close"}));
  const failed = transition(item, rule, maintained, {action:"retest", retest:"OBS-BEFORE-NO"});
  assert.equal(failed.stage, "maintained");
  assert.equal(failed.events.at(-1).label, "复测未通过 · UCI 第 612 周期");
  assert.throws(() => transition(item, rule, failed, {action:"retest", retest:"OBS-BEFORE-NO"}));
  const foreign = {...item, retests:item.retests.map(row => ({...row, installation:"INSTALL-200"}))};
  assert.equal(transition(foreign, rule, failed, {action:"retest", retest:"OBS-BEFORE-OK"}).stage, "maintained");
  const verified = transition(item, rule, failed, {action:"retest", retest:"OBS-BEFORE-OK"});
  assert.equal(verified.stage, "verified");
  const closed = transition(item, rule, verified, {action:"close"});
  assert.equal(closed.stage, "closed");
  assert.equal(closed.order, "WO-AL-BEFORE");
  assert.equal(item.observation.uci.pumpCode, 2);
});
