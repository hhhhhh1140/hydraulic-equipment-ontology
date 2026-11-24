const {test} = require("node:test");
const assert = require("node:assert/strict");
const {run} = require("../visualization/simulation-model.js");

const measured = Object.freeze([3, 100, 2, 90, 1]);

test("both branches start from the same measured labels and only the sandbox changes", () => {
  assert.deepEqual(run(measured, "pump", 0).states.map(state => state.value), measured.slice(0, 4));
  assert.deepEqual(run(measured, "hold", 8).states.map(state => state.value), measured.slice(0, 4));
  assert.deepEqual(run(measured, "pump", 8).states.map(state => state.value), [100, 100, 0, 130]);
  assert.deepEqual(measured, [3, 100, 2, 90, 1]);
});

test("sequential jobs respect duration and priority", () => {
  assert.equal(run(measured, "pump", 2).completed, 0);
  assert.equal(run(measured, "pump", 3).states.find(state => state.id === "Pump").value, 0);
  assert.equal(run(measured, "accumulator", 2).states.find(state => state.id === "Accumulator").value, 130);
  assert.deepEqual(run(measured, "pump", 8).events.map(event => [event.step,event.rule]),
    [[0,"R2"], [3,"R4"], [3,"R2"], [5,"R4"], [5,"R2"], [7,"R4"]]);
});

test("cumulative exposure counts intervals and healthy components are not queued", () => {
  assert.equal(run(measured, "hold", 8).cumulativeSevere, 24);
  assert.equal(run(measured, "pump", 8).cumulativeSevere, 15);
  assert.equal(run([100, 100, 0, 130, 0], "shortest", 12).events.length, 0);
});
