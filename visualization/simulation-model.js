/* 维护沙盘。工况来自实测，维护顺序、耗时和恢复效果由演示规则定义。 */
(function (root) {
  "use strict";

  const components = [
    {id:"Cooler", name:"冷却器", nominal:100, severity:{3:2, 20:1, 100:0}, duration:2},
    {id:"Valve", name:"换向阀", nominal:100, severity:{73:2, 80:2, 90:1, 100:0}, duration:1},
    {id:"Pump", name:"液压泵", nominal:0, severity:{0:0, 1:1, 2:2}, duration:3},
    {id:"Accumulator", name:"蓄能器", nominal:130, severity:{90:2, 100:2, 115:1, 130:0}, duration:2}
  ];
  const policies = {
    hold: {label:"暂缓维护", rank:[]},
    pump: {label:"液压泵优先", rank:["Pump", "Accumulator", "Cooler", "Valve"]},
    accumulator: {label:"蓄能器优先", rank:["Accumulator", "Pump", "Cooler", "Valve"]},
    shortest: {label:"最短工序优先", rank:["Valve", "Cooler", "Accumulator", "Pump"]}
  };
  const rules = [
    "R1 起点：直接复制所选周期的四项工况标签。非基准值进入待处理清单。",
    "R2 调度：只有一组维修人员，同一时间处理一个部件。各方案按预设优先级顺序执行，暂缓方案不安排维护。",
    "R3 耗时：冷却器 2 步、换向阀 1 步、液压泵 3 步、蓄能器 2 步。步数是演示单位。",
    "R4 恢复：维护完成时，只把本部件的模拟工况设为基准值。每次动作只影响目标部件。初始实测标签和传感器读数保持只读。",
    "R5 指标：按演示分级统计当前严重工况部件数。累计严重部件步数按每一步开始时的严重部件数累加。"
  ];

  function createSchedule(profile, order) {
    const measured = components.map(({id}, index) => {
      const value = profile[index];
      if (!Object.hasOwn(components[index].severity, value)) throw new RangeError(`Invalid condition for ${id}`);
      return value;
    });
    let nextStart = 0;
    const jobs = order.flatMap(id => {
      const index = components.findIndex(component => component.id === id);
      const component = components[index];
      if (measured[index] === component.nominal) return [];
      const start = nextStart;
      nextStart += component.duration;
      return [{id, name:component.name, start, end:nextStart, from:measured[index], to:component.nominal}];
    });
    return {measured, jobs};
  }

  function atStep(schedule, step) {
    const {measured, jobs} = schedule;
    const states = components.map((component, index) => {
      const job = jobs.find(item => item.id === component.id);
      const done = job && job.end <= step;
      const value = done ? component.nominal : measured[index];
      const status = done ? "已恢复" : job && job.start <= step ? "维护中" :
        value === component.nominal ? "基准工况" : "待处理";
      return {...component, value, status, severity:component.severity[value]};
    });
    return {
      states,
      remaining:states.filter(state => state.severity > 0).length,
      severe:states.filter(state => state.severity === 2).length,
      completed:jobs.filter(job => job.end <= step).length
    };
  }

  function run(profile, policy, step) {
    if (!Object.hasOwn(policies, policy)) throw new RangeError("Unknown maintenance policy");
    if (!Number.isInteger(step) || step < 0 || step > 12) throw new RangeError("Step must be from 0 to 12");
    const schedule = createSchedule(profile, policies[policy].rank);
    const result = atStep(schedule, step);
    const cumulativeSevere = Array.from({length:step}, (_, index) => atStep(schedule, index).severe)
      .reduce((sum, count) => sum + count, 0);
    const events = schedule.jobs.flatMap(job => [
      {step:job.start, rule:"R2", description:`开始维护${job.name}`},
      {step:job.end, rule:"R4", description:`${job.name}完成维护，模拟工况值 ${job.from} → ${job.to}`}
    ]).filter(event => event.step <= step);
    return {...result, cumulativeSevere, events};
  }

  const model = {components, policies, rules, run};
  if (typeof module === "object" && module.exports) module.exports = model;
  else root.HydraulicSimulation = model;
})(globalThis);
