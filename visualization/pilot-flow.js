(function (root) {
  "use strict";

  const stages = {
    review:"待核验", confirmed:"已确认故障", draft:"工单草稿", approved:"已审批派工",
    maintained:"待复测", verified:"复测通过", closed:"已结案"
  };
  const schedule = {
    confirm:{from:"review", to:"confirmed", minutes:30, label:"人工确认内泄漏", actor:"演示工程师"},
    draft:{from:"confirmed", to:"draft", minutes:40, label:"生成维修工单草稿", actor:"演示工程师"},
    approve:{from:"draft", to:"approved", minutes:60, label:"审批并派工", actor:"演示审批人"},
    maintain:{from:"approved", to:"maintained", minutes:180, label:"登记维护完成", actor:"演示维修人员"},
    retest:{from:"maintained", to:"verified", label:"提交复测", actor:"演示工程师"},
    close:{from:"verified", to:"closed", label:"确认结案", actor:"演示工程师"}
  };

  function canConfirm(item, rule) {
    return item.quality === "QUALIFIED" && !!item.asset &&
      item.observation?.uci?.pumpCode === rule.labelCode;
  }

  function initial(item) {
    if (!item.history) return {stage:"review", events:[], order:null};
    const h = item.history;
    const retest = item.retests.find(test => test.id === h.retest);
    return {
      stage:"closed", order:h.order.id,
      events:[
        {at:h.confirmedAt, label:"人工确认内泄漏", actor:h.reviewer},
        {at:h.order.approvedAt, label:"审批并派工", actor:"演示审批人"},
        {at:h.order.completedAt, label:h.order.summary, actor:"演示维修人员"},
        {at:retest.at, label:`复测通过 · UCI 第 ${retest.cycle} 周期`, actor:"演示工程师"},
        {at:h.closedAt, label:"确认结案", actor:"演示工程师"}
      ]
    };
  }

  function after(at, minutes) {
    return new Date(Date.parse(at) + minutes * 60_000).toISOString();
  }

  function transition(item, rule, state, event) {
    const step = schedule[event.action];
    if (!step || state.stage !== step.from || (event.action === "confirm" && !canConfirm(item, rule))) {
      throw new Error("当前状态或证据不支持这一步。");
    }

    let {label} = step;
    let stage = step.to;
    let at = step.minutes ? after(item.at, step.minutes) : after(state.events.at(-1).at, 15);
    if (event.action === "retest") {
      const test = item.retests.find(candidate => candidate.id === event.retest);
      if (!test || Date.parse(test.at) <= Date.parse(state.events.at(-1).at)) {
        throw new Error("复测必须发生在维护完成和已记录的复测之后。");
      }
      at = test.at;
      const passed = test.quality === "QUALIFIED" && test.installation === item.installation &&
        test.uci?.pumpCode === rule.verificationCode;
      stage = passed ? "verified" : "maintained";
      label = `复测${passed ? "通过" : "未通过"} · UCI 第 ${test.cycle} 周期`;
    }
    return {stage, events:[...state.events, {at, label, actor:step.actor}],
      order:event.action === "draft" ? `WO-${item.id}` : state.order};
  }

  function replay(item, rule, events) {
    return events.reduce((state, event) => transition(item, rule, state, event), initial(item));
  }

  const flow = {stages, schedule, canConfirm, initial, transition, replay};
  if (typeof module === "object" && module.exports) module.exports = flow;
  else root.HydraulicPilotFlow = flow;
})(globalThis);
