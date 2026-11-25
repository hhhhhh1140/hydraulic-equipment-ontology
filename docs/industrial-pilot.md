# 液压站维修闭环 · 工业试点第 1 阶段

[打开在线回放](https://hhhhhh1140.github.io/hydraulic-equipment-ontology/?view=pilot)

用公开试验数据先验证数据契约、证据追溯和工单流程。UCI 447 的周期行号、PS1 均压、稳定性标记和实验工况标签来自原始数据。工厂层级、资产、安装日期、传感器到设备的映射、告警、工单、人员和时间均为明确标注的合成回放数据。第 1788 周期作为无泵内泄漏的复测样本，来自独立实验工况，不能据它推断第 611 周期经历过维修。

## 数据入口

| 来源 | 文件 | 主要字段 |
|---|---|---|
| 设备台账 | [assets.json](../data/industrial-demo/assets.json) | 工厂和工位、安装位、资产 ID、安装起止时间、测点 ID 和契约单位 |
| 历史测点 | [historian.json](../data/industrial-demo/historian.json) | 记录 ID、测点 ID、回放时间、原始周期行号和上报单位 |
| 维修系统 | [maintenance.json](../data/industrial-demo/maintenance.json) | 告警 ID、工单、确认人、审批和完工时间、复测记录、规则版本 |

[OWL 本体](../model/industrial/ontology.ttl) 定义生产层级和业务对象，观测用 SOSA 属性表达测点、观测量和目标，PROV-O 记录 UCI 摘要来源。导入器以 `[from, until)` 判断哪条安装记录有效。同一安装位置或同一资产的区间重叠时，整批导入会报错。缺测、单位不符或工况可能尚未稳定的记录带质量状态，可供追溯和排查。

## 实际操作

1. 进入「维修闭环」。选择「换装前」，核对告警时的资产为 **P-100**，证据为 `PS1.txt` 第 **611** 行。
2. 依次人工确认故障、生成工单草稿、审批派工和登记维护完成。
3. 提交第 **612** 周期复测，工单保留「待复测」。再提交第 **1788** 周期复测，通过后可确认结案。
4. 查看「恰在换装时」案例，资产应当是 **P-200**。第 610 周期、缺测和单位不一致的案例均会停在待核验。

浏览器会保存本机样例操作，页面上的身份和事件时刻都是演示设定。仓库内的 RDF 文件和七天查询保持为可重复构建的样例快照。

## 验收和重建

```bash
python scripts/build_industrial.py
python -m unittest discover -s tests -p 'test_industrial.py'
node --test tests/*.test.cjs
```

`build_industrial.py` 使用已构建的 UCI RDF，不需要重新下载原始数据。完整重建运行 `python scripts/build.py --download`。

[七天闭环查询](../queries/industrial/closed-pump-faults.rq) 以 **2026-11-25 00:00 UTC** 为回放截止时刻。对 [回放实例](../model/industrial/replay.ttl) 执行，应返回 **P-200 → DEMO-HP01-PS1 → 故障样本 611 → 工单 WO-DEMO-001 → 复测样本 1788 → 通过**。[SHACL](../model/industrial/shapes.ttl) 校验记录类型、单位一致性、工单和复测引用。

真实现场试点需要由工厂提供台账、测点历史和已审批的维修记录。应用接入时还需要定义授权执行身份、服务端审计、异常与延迟处理规则，并用实际工单和复测结果验收。
