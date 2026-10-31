# 十份失败运行的完整阅读记录

来源均为 `../../experiments/2026-10-21-ablation/raw/prompt-formal-runs.jsonl`，行号为 runIndex+1。本轮逐份阅读了完整 session，包括所有用户、助手、工具请求和结果、最终回复，并对照 checks 与 artifacts；没有只读失败标签。其余失败的机器分类见 failure-annotations.jsonl。

| runIndex / 行号 | 任务 | 完整轨迹及根因 |
|---|---|---|
| 2 / 3 | train-merge | 正确读取两份输入；Python浅合并保留null，MD5前后一致；最后追加 `file merged.json` 得到127。产物正确，严格失败来自无必要的缺失环境命令，非合并算法错误。 |
| 8 / 9 | select-space-path | 题面只要求“大于0的数各乘2”，模型使用 `x*2 if x>0 else x`，得到 `[0,4,-4,14,4]`；评分要求 `[4,14,4]`。未明确删除非正数，是任务/评分契约歧义，不能据此认定答案错误；原失败标签保留。 |
| 14 / 15 | train-version-sort | 三段转整数排序正确，保留重复项，输入MD5不变；最终 `file` 缺失。不是按字典序误排。 |
| 50 / 51 | train-orders | 第一条命令 `cd /Users/x/hermes-workspace/Light-Claw` 在Docker内失败；随后pwd定位/workspace，整数分累计3单1500分正确。真实请求存在两套cwd，来自AgentSession追加宿主cwd；后续纠正多花模型请求。 |
| 64 / 65 | final-stable-dedup | trim、大小写敏感去重及首次顺序均正确，得到A/a/B；输入未变。末尾 `file scratch/tags-clean.json` 不存在，最终说明正确。不是稳定去重失败。 |
| 66 / 67 | final-markdown-section | 先cat -A显示非ASCII转义，再用awk提取风险段，Python strip后正文正确；调用缺失file后又增加一次Python编码确认。环境能力未说明造成一次错误和额外模型往返。 |
| 74 / 75 | final-unicode-path | 包含空格/中文的路径均有引号，排序结果z/a/b正确；缺失file后增加Python decode及MD5检查。不是unicode或路径引用错误。 |
| 82 / 83 | final-text-replacement | sed仅替换大写NAME，保留小写name、单括号、空行和末尾换行，MD5输入一致；缺失file引发127。任务已完成，但严格零工具错误检查未过；不修改检查器。 |
| 83 / 84 | final-text-replacement | Python字节替换正确；file失败后再Python decode验证44字节，最终产物完全匹配。其额外检查并未增加产物质量，只增加请求。 |
| 88 / 89 | final-unicode-path | 首次路径fallback未执行（/workspace分支成功），读取、排序、写入和MD5正确；file127后直接最终答复。不能因为文本含宿主路径fallback就把本次归为实际cwd失败，实际主因是缺失命令。 |

上述10份中：缺失file 8份，实际cwd错误1份，检查契约歧义1份。这是人工选取的根因审阅样本，不是总体失败分布；总体按所有运行统计。归档哈希经本轮重新核对，原始任务、预期、session及得分未更改。
