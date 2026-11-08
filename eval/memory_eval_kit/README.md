# Light-Claw 记忆评测包（中文合成测试集 + 判分器 + 生成器）

## 内容

```
memory_eval_kit/
├── README.md            本文件
├── gen_testset.py       确定性生成器（同种子同数据；可改体量/种子重新生成）
├── scorer.py            程序化判分器（所有实验臂必须共用，不得改写）
└── testset/
    ├── cases.jsonl      232 道题（dev 116 + test 116）
    ├── stats.json       各夹具体量、索引是否超 4 KiB、受截断影响的题数
    └── fixtures/<fid>/  8 个夹具：fx{012,032,064,128}k-{dev,test}
        ├── facts.json   事实库（唯一真值）
        ├── monolith/    旧版布局（S0 / T 臂）
        └── index_notes/ 现版布局（S1 臂）
```

## 夹具体量（频道 MEMORY.md，旧版布局，字节）

| 夹具 | 旧版频道文件 | 现版频道索引 | 索引是否超 4 KiB | 受截断影响的题（dev / test） |
|---|---|---|---|---|
| 012k | ≈12.7 KB | 1.6–1.7 KB | 否 | 0 / 0 |
| 032k | ≈32.8 KB | 3.4–3.5 KB | 否（接近上限） | 0 / 0 |
| 064k | ≈65.6 KB | 6.6–7.0 KB | 是 | 12 / 9 |
| 128k | ≈131 KB | 11.9–12.7 KB | 是 | 18 / 13 |

名称里的 KiB 是目标体量；最小夹具因为题目事实本身就要占约 12 KB，所以从 12 起。体量越大，现版索引越容易被 4 KiB 截断，这是被测行为之一。

## 目录映射到 Light-Claw 工作区

| 夹具文件 | 工作区位置 |
|---|---|
| `monolith/MEMORY.md` 或 `index_notes/MEMORY.md` | 工作区根目录 `MEMORY.md`（全局记忆） |
| `monolith/channel/MEMORY.md` 或 `index_notes/channel/MEMORY.md` | `<chat_id>/MEMORY.md` |
| `index_notes/channel/memory/*.md` | `<chat_id>/memory/*.md` |
| `index_notes/.shared/memory/style-guide.md` | `.shared/memory/style-guide.md` |

评测用的 chat_id 固定为 `eval-chat-001`；每次运行前把夹具拷进一份全新的工作区副本。

## 题目字段

| 字段 | 含义 |
|---|---|
| `id` / `fixture` / `split` / `size_kib` / `category` | 标识；split 为 dev 或 test；category 见下表 |
| `question` | 发给 agent 的用户消息，原样使用 |
| `check` | 判分规格，交给 `scorer.score(check, response)` |
| `golden` / `bad` | 自检用：golden 必须判过，bad 必须判错（`python scorer.py --selftest testset/cases.jsonl`） |
| `facts` | 该题依赖的事实 id（对应 `facts.json`） |
| `meta.gold_reads_s1` | 现版布局下应当读取的笔记（用于算回查的精确率/召回率） |
| `meta.s1_index_cut` | 该题所需的索引条目是否落在现版 4 KiB 截断线之外 |
| `meta.hot` / `position` / `placement` / `n_corrections` / `hops` | 分层分析用的标签 |

## 题型（每个夹具 29 题）

| 类别 | 题数 | 测什么 |
|---|---|---|
| `index_hit` | 4 | 答案是索引里的热点事实：现版应不用回查，成本更低 |
| `note_needed` | 4 | 答案只在笔记里：现版必须读对笔记；弱模型是否不回查 |
| `multi_hop` | 3 | 项目 → 负责人 → 分机号，需读两份不同笔记 |
| `abstain` | 3 | 实体存在但该属性没记录，另一实体有近似值：测幻觉 |
| `update` | 4 | 事实被更正过（2 条热点 + 2 条非热点，其中一条更正两次）；更正追加在末尾：测截断丢更正、陈旧值 |
| `position` | 3 | 热点事实位于文件头 / 中 / 尾：测截断与位置效应 |
| `irrelevant` | 3 | 与记忆无关的算术题：测常驻内容的浪费与干扰，应零次回查 |
| `implicit_rule` | 5 | 必须隐式遵循的常驻规则（日期格式、无表格、称呼、金额单位、签名、文件名、24 小时制、两句话以内、无项目符号列表之一）；其中 3 条在索引内联，2 条藏在链接笔记后（`placement` 标签） |

## 使用规则

1. dev 用来迭代改进；test 只在改进冻结后跑一次最终评测。
2. 改进版的记忆布局只能从 `facts.json` 派生，不得读取 `cases.jsonl`，也不得把题库里的实体名、规则文案写进提示词或代码。
3. 现版布局是"朴素追加式"模型：热点事实内联在索引、其余在笔记；更正追加到事实所在文件的末尾；索引按时间顺序追加。它用来复现现版的缺陷，不代表唯一合理的组织方式。
4. 判分器只读，不得为了让结果好看而改动。
5. 需要换世界或换规模时：`python gen_testset.py --out testset2 --sizes 12,32,64,128 --seed-base 9000`。
