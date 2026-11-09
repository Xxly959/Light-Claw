# 外部记忆评测数据

本流程准备固定来源的原始数据和小样本清单。数据、题目、参考答案和原始标注均保存在 Git 忽略的 `eval/external/`。抽样清单用于后续独立评测，当前状态只表示数据准备。

## 获取和抽样

从仓库根目录运行。Python 需要 3.11 或更新版本，Parquet 读取使用 PyArrow。

```sh
rtk proxy uv run --no-project --python 3.12 --with pyarrow==26.0.1 -- python -B eval/harness/external.py
rtk proxy uv run --offline --no-project --python 3.12 --with pyarrow==26.0.1 -- python -B eval/harness/external.py --local-only
```

首条命令只下载下表中的四个文件，校验固定版本的 SHA-256 后写入 `eval/external/cache/`。第二条命令校验缓存并重新抽样，适合验证数据与清单可复现。两条命令会重写 `eval/external/manifest.json`。任一必需数据准备失败时，命令退出码为 1，清单保留错误及其他数据集的结果。

| 数据 | 许可 | 固定来源 | 抽样 |
| --- | --- | --- | --- |
| LongMemEval-S | MIT | [2025 年 9 月清洗版](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/blob/98d7416c24c778c2fee6e6f3006e7a073259d48f/longmemeval_s_cleaned.json)，约 277 MB | 500 题中选 120 题，以官方 `question_type` 和 `question_id` 是否以 `_abs` 结尾分层。配额按母体规模近似比例分配，每个非空层至少一题。 |
| MemoryAgentBench FactConsolidation | MIT 数据卡 | [`Conflict_Resolution` Parquet](https://huggingface.co/datasets/ai-hyz/MemoryAgentBench/blob/7ea066982b140a19337e17e60d45d4076e042faf/data/Conflict_Resolution-00000-of-00001.parquet)，约 1.49 MB | `factconsolidation_sh_6k` 和 `factconsolidation_mh_6k` 各取 20 题。每组保持原始文本及陈述顺序。 |
| MemoryAgentBench EventQA | MIT 数据卡 | [`Accurate_Retrieval` Parquet](https://huggingface.co/datasets/ai-hyz/MemoryAgentBench/blob/7ea066982b140a19337e17e60d45d4076e042faf/data/Accurate_Retrieval-00000-of-00001.parquet)，约 20 MB | 选用上游发布的 `eventqa_65536` 版本，5 篇小说各取 4 题。 |
| LoCoMo | [CC BY-NC 4.0](https://github.com/snap-research/locomo/blob/main/LICENSE.txt) | [Snap Research `locomo10.json`](https://github.com/snap-research/locomo/blob/cbfbc1dba6bc53d00625212a0f22d55ffee7c1fc/data/locomo10.json)，约 2.8 MB | 非商业评测冒烟样本。10 段对话中有 9 段覆盖 5 类题，从中取 2 段，每段每类取 1 题。 |
| Tencent CL-bench | [自定义评测许可](https://huggingface.co/datasets/tencent/CL-bench/blob/b28a5832a09b0d96c0cf4c22e90d7c60ede25b80/LICENSE.txt) | [官方 `CL-bench.jsonl`](https://huggingface.co/datasets/tencent/CL-bench/blob/b28a5832a09b0d96c0cf4c22e90d7c60ede25b80/CL-bench.jsonl)，约 90.1 MB | 本轮跳过。数据许可允许评估、测试和基准测量，限制训练、微调、校准、蒸馏、适配和参数更新。第三方材料遵循各自原始许可。 |

所有抽样以固定种子 `20261108` 和稳定来源 ID 计算 SHA-256 排序，保留所选题目的原始顺序索引。每份 `prepared/<dataset>.jsonl` 的一行对应一段共享历史，含 `source_id`、上游 `record`，以及适用时的 `question_indices`。`question_indices` 从零开始。LongMemEval-S 每段历史对应一题，题目 ID 直接作为 `source_id`。清单另记录每份样本的来源、版本、数据许可、摘要值、样本数、题数和选择索引。`prepared` 表示样本可供后续运行。

## 回放和评分边界

- **LongMemEval-S** 按原有次序对齐 `haystack_sessions`、`haystack_dates` 和 `haystack_session_ids`，保留用户和助手角色。逐轮向固定的记忆写入器提供历史，隔离不同题目的状态。`answer`、`answer_session_ids` 和每轮的 `has_answer` 供评分或检索诊断使用。`_abs` 是拒答标签，原 `question_type` 仍用于分层。官方回答质量评分接收含 `question_id`、`hypothesis` 的 JSONL，按题型使用不同裁判提示。自定义的字符串匹配只能作为代理指标。 [官方说明](https://github.com/xiaowu0162/LongMemEval#-dataset-format) · [官方评分代码](https://github.com/xiaowu0162/LongMemEval/blob/main/src/evaluation/evaluate_qa.py)
- **MemoryAgentBench** 每段原文按顺序分块注入，完成记忆构建后，从同一冻结状态独立提问。官方论文通常以 512 token 分块回放 FactConsolidation、以 4096 token 分块回放 EventQA。FactConsolidation 的后续陈述覆盖较早冲突事实，测试更新后回答和多跳推理。EventQA 提供完整原题的前序事件与候选项，测试小说事件序列检索。只使用 `context` 构建记忆，所选 `questions` 在提问阶段传入，`answers` 保留供评分。两项的官方代码口径为 `substring_exact_match`，并通过 `metadata.qa_pair_ids` 关联回答。小样本和缩短上下文的结果需分别标明。 [官方数据卡](https://huggingface.co/datasets/ai-hyz/MemoryAgentBench) · [论文协议](https://arxiv.org/html/2507.05257v4#S3.SS3) · [评分指标](https://github.com/HUST-AI-HYZ/MemoryAgentBench#-clarification-on-evaluation-metrics)
- **LoCoMo** 按 `session_<num>` 的数值顺序回放对话，保留时间和说话人。图片原件未随数据发布，文本冒烟保留对话文字，图片处理另计。`qa`、`evidence` 和发布的摘要字段留在评分侧。`category=5` 走拒答分支，`adversarial_answer` 是干扰答案，发布文件中多数此类题没有 `answer` 字段。官方评分对普通题计算词级 F1，对拒答题使用固定词组判断。发布数据有 1,986 个问题，本地 10 题只覆盖适配路径。 [官方数据说明](https://github.com/snap-research/locomo#data) · [官方评分实现](https://github.com/snap-research/locomo/blob/main/task_eval/evaluation.py)

回放前为固定写入器记录模型、上下文限额、每块和每次写入的上限。块边界、跳过、截断及失败分别记录。源数据的标注、参考答案和问题不得进入构建记忆的输入。预制记忆、裁判配置和评分结果属于后续实验产物。
