# 已知失败的追加复测

72 次主对照保留为 fixed-v1。其缺失命令提示只有“可用列表”，仍出现 file 缺失错误。因此 fixed-v2 明确列出已确认缺失的命令并要求使用现有替代。

在已知 final-unicode-path、final-text-replacement、final-nested-config 三项上，与同一 before 快照各重复 3 次，共追加18次；参数和容器不变。此轮为故障定向回归，不能当作盲测或覆盖其余九项任务；总实验预计90次，不覆盖旧记录。
