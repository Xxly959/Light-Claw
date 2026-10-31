import hashlib
import json
import pathlib

OUT = pathlib.Path(__file__).resolve().parent
cases = []

def add(split, name, instruction, fixtures, outputs):
    cases.append({"split": split, "id": name, "prompt": instruction + " 所有输入文件必须保持原样。输出文件使用UTF-8，完成后简短说明。",
                  "fixtures": fixtures, "outputs": outputs})

def j(value):
    return json.dumps(value, ensure_ascii=False, indent=2) + "\n"

add("training", "train-orders", "读取scratch/orders.csv，只统计status=paid的订单，用整数分计算总额；输出scratch/summary.json，且只含paid_count和total_cents两个数值字段。",
    {"scratch/orders.csv": "id,status,amount_cents\na,paid,1299\nb,cancelled,9999\nc,paid,201\nd,paid,0\n"},
    {"scratch/summary.json": {"json": {"paid_count": 3, "total_cents": 1500}}})
add("training", "train-contacts", "读取scratch/contacts.json，将email去除两端空格并转小写后去重，保留首次出现的记录及其name，输出scratch/clean.json，格式为对象数组，只保留name和规范化email。",
    {"scratch/contacts.json": j([{"name": "甲", "email": " A@EXAMPLE.COM "}, {"name": "乙", "email": "a@example.com"}, {"name": "丙", "email": "B@example.com"}])},
    {"scratch/clean.json": {"json": [{"name": "甲", "email": "a@example.com"}, {"name": "丙", "email": "b@example.com"}]}})
add("training", "train-merge", "读取scratch/base.json和scratch/override.json，进行浅合并，同名键以override为准，null必须保留。输出scratch/merged.json。",
    {"scratch/base.json": j({"enabled": True, "limit": 5, "note": "old"}), "scratch/override.json": j({"enabled": False, "note": None})},
    {"scratch/merged.json": {"json": {"enabled": False, "limit": 5, "note": None}}})
add("training", "train-markdown", "读取scratch/notes.md，提取所有以'- [ ] '开头的未完成项，去掉该前缀，保持顺序；输出scratch/todo.json，格式为字符串数组。",
    {"scratch/notes.md": "# 计划\n- [x] 已完成\n- [ ] 检查配置\n普通行\n- [ ] 补充测试\n"},
    {"scratch/todo.json": {"json": ["检查配置", "补充测试"]}})
add("training", "train-version-sort", "读取scratch/versions.json，按三段十进制版本号数值从小到大排序，保留重复项；输出scratch/sorted.json。不能按字符串字典序排序。",
    {"scratch/versions.json": j(["1.10.0", "1.2.9", "2.0.0", "1.2.10", "1.2.9"])},
    {"scratch/sorted.json": {"json": ["1.2.9", "1.2.9", "1.2.10", "1.10.0", "2.0.0"]}})
add("training", "train-invalid-lines", "逐行读取scratch/events.jsonl，跳过非法JSON行，对合法对象的整数value求和。输出scratch/result.json且只含sum和invalid_lines；invalid_lines为非法行的1-based行号数组。",
    {"scratch/events.jsonl": '{"value":3}\nnot-json\n{"value":-2}\n{"value":7}\n'},
    {"scratch/result.json": {"json": {"sum": 8, "invalid_lines": [2]}}})

add("selection", "select-diff", "比较scratch/old.json和scratch/new.json，只输出值发生变化且两边均存在的键，按键字典序排序，写入scratch/changed.json字符串数组。",
    {"scratch/old.json": j({"a": 1, "b": True, "c": None}), "scratch/new.json": j({"a": 2, "b": True, "c": "new", "d": 4})},
    {"scratch/changed.json": {"json": ["a", "c"]}})
add("selection", "select-latest", "读取scratch/records.json，对每个id保留revision最大的记录，按id升序输出到scratch/latest.json；只保留id、revision和value三个字段。",
    {"scratch/records.json": j([{"id": "b", "revision": 1, "value": "old"}, {"id": "a", "revision": 4, "value": "A"}, {"id": "b", "revision": 3, "value": "new"}])},
    {"scratch/latest.json": {"json": [{"id": "a", "revision": 4, "value": "A"}, {"id": "b", "revision": 3, "value": "new"}]}})
add("selection", "select-space-path", "读取scratch/input data/值.json，将数组中严格大于0的数各乘2，保持顺序，输出scratch/output data/结果.json数组。",
    {"scratch/input data/值.json": j([0, 2, -4, 7, 2])},
    {"scratch/output data/结果.json": {"json": [4, 14, 4]}})
add("selection", "select-two-artifacts", "读取scratch/items.json，将active=true的id按升序写入scratch/active.json数组，同时写scratch/count.json对象，只含count，值为active条数。",
    {"scratch/items.json": j([{"id": "z", "active": True}, {"id": "a", "active": False}, {"id": "m", "active": True}])},
    {"scratch/active.json": {"json": ["m", "z"]}, "scratch/count.json": {"json": {"count": 2}}})

add("final", "final-inventory-join", "读取scratch/stock.json和scratch/reserved.json，按sku求available=库存-预留；不存在的预留按0，忽略仅预留中存在的sku，允许负数。按sku升序输出scratch/available.json对象数组，只含sku与available。",
    {"scratch/stock.json": j({"B": 7, "A": 2, "C": 0}), "scratch/reserved.json": j({"A": 3, "B": 2, "X": 9})},
    {"scratch/available.json": {"json": [{"sku": "A", "available": -1}, {"sku": "B", "available": 5}, {"sku": "C", "available": 0}]}})
add("final", "final-money-csv", "读取scratch/transactions.csv，以整数分累计每个account的收入减退款（kind=refund为减），按account升序写scratch/balances.json，格式为account到整数余额的对象。",
    {"scratch/transactions.csv": "account,kind,cents\nx,income,101\ny,income,999\nx,refund,20\ny,refund,1000\nx,income,9\n"},
    {"scratch/balances.json": {"json": {"x": 90, "y": -1}}})
add("final", "final-stable-dedup", "读取scratch/tags.json，各字符串trim后按大小写敏感去重，保留首次出现顺序，删除空字符串，输出scratch/tags-clean.json。",
    {"scratch/tags.json": j([" A ", "", "a", "A", " B", "a ", "  ", "B"])},
    {"scratch/tags-clean.json": {"json": ["A", "a", "B"]}})
add("final", "final-markdown-section", "读取scratch/report.md，只提取'## 风险'标题下面、下一个二级标题之前的正文，去掉首尾空白，写入scratch/risk.txt；不要包含标题。",
    {"scratch/report.md": "# 报告\n## 结果\n通过。\n## 风险\n\n需要人工复核。\n- 外部接口未测\n\n## 后续\n发布。\n"},
    {"scratch/risk.txt": {"textTrimmed": "需要人工复核。\n- 外部接口未测"}})
add("final", "final-nested-config", "读取scratch/config.json，生成scratch/config-new.json：只把service.timeout改为45，并在service内新增retries=2，其余字段和值必须完整保留。",
    {"scratch/config.json": j({"service": {"timeout": 10, "enabled": False, "label": None}, "owners": ["甲", "乙"], "version": 3})},
    {"scratch/config-new.json": {"json": {"service": {"timeout": 45, "enabled": False, "label": None, "retries": 2}, "owners": ["甲", "乙"], "version": 3}}})
add("final", "final-version-filter", "读取scratch/releases.json，去掉以'-beta'结尾的版本，再按三段整数版本从大到小排序，输出scratch/stable.json，保留重复。",
    {"scratch/releases.json": j(["2.9.0", "2.10.0", "3.0.0-beta", "2.10.1", "2.10.0"])},
    {"scratch/stable.json": {"json": ["2.10.1", "2.10.0", "2.10.0", "2.9.0"]}})
add("final", "final-jsonl-errors", "读取scratch/log.jsonl，跳过空白行和非法JSON；只对level=error的合法对象收集code，保持出现顺序。输出scratch/errors.json且只含codes数组及invalid_lines数组，后者为非法非空行的1-based行号。",
    {"scratch/log.jsonl": '{"level":"info","code":"I"}\n\n{broken}\n{"level":"error","code":"E2"}\n{"level":"error","code":"E1"}\n'},
    {"scratch/errors.json": {"json": {"codes": ["E2", "E1"], "invalid_lines": [3]}}})
add("final", "final-unicode-path", "读取scratch/资料 文件/名单.json，按score降序排列，同分按name升序，输出scratch/结果 文件/top.json，只保留前3条完整记录。",
    {"scratch/资料 文件/名单.json": j([{"name": "b", "score": 9}, {"name": "a", "score": 9}, {"name": "z", "score": 12}, {"name": "c", "score": 1}])},
    {"scratch/结果 文件/top.json": {"json": [{"name": "z", "score": 12}, {"name": "a", "score": 9}, {"name": "b", "score": 9}]}})
add("final", "final-multi-file-consistency", "读取scratch/users.json，将enabled=true的用户名按字典序写入scratch/enabled.json数组；同时生成scratch/manifest.json，只含file='enabled.json'与count两个字段，count必须等于数组长度。",
    {"scratch/users.json": j([{"name": "c", "enabled": False}, {"name": "b", "enabled": True}, {"name": "a", "enabled": True}])},
    {"scratch/enabled.json": {"json": ["a", "b"]}, "scratch/manifest.json": {"json": {"file": "enabled.json", "count": 2}}})
add("final", "final-null-vs-missing", "读取scratch/rows.json，只保留显式拥有note键且note值为null的记录，按id升序输出scratch/null-notes.json字符串id数组。缺少note与空字符串都不能算null。",
    {"scratch/rows.json": j([{"id": "b", "note": None}, {"id": "a"}, {"id": "c", "note": ""}, {"id": "d", "note": None}])},
    {"scratch/null-notes.json": {"json": ["b", "d"]}})
add("final", "final-range-boundaries", "读取scratch/measurements.json，只统计10<=value<20的记录，输出scratch/stats.json，只含count和sum两个数值字段，sum为这些value之和。",
    {"scratch/measurements.json": j([{"value": 9}, {"value": 10}, {"value": 19}, {"value": 20}, {"value": 15}, {"value": -1}])},
    {"scratch/stats.json": {"json": {"count": 3, "sum": 44}}})
add("final", "final-text-replacement", "读取scratch/template.txt，将全部字面量'{{NAME}}'替换为'LightClaw'，其他字符（包括大括号和空行）保持不变，结果写scratch/rendered.txt。",
    {"scratch/template.txt": "Hello {{NAME}}\n\n{{NAME}}: {keep}\n{{name}}\n"},
    {"scratch/rendered.txt": {"textExact": "Hello LightClaw\n\nLightClaw: {keep}\n{{name}}\n"}})

assert len(cases) == 22
assert len({case["id"] for case in cases}) == 22
path = OUT / "prompt-dataset.json"
path.write_text(j(cases))
print(json.dumps({"cases": len(cases), "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                  "splits": {split: sum(case["split"] == split for case in cases) for split in ["training", "selection", "final"]}}))
