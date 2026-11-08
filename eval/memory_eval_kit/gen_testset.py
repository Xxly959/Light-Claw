#!/usr/bin/env python3
"""中文长期记忆评测集生成器（确定性：同样的种子得到同样的数据）。

用法：
    python gen_testset.py --out testset --sizes 12,32,64,128

产物：
    testset/cases.jsonl          题目（含 split、类别、判分规格、自检用的 golden/bad 答案）
    testset/fixtures/<fid>/      记忆夹具
        facts.json               事实库（唯一真值；改进版的记忆布局必须只从它派生，不得读题目）
        monolith/                旧版布局：一个大 MEMORY.md（全局 + 频道），更正追加在文件末尾
        index_notes/             现版布局：<=4KiB 的追加式索引 + memory/ 笔记
    testset/stats.json           各夹具体量与“现版索引是否被截断”的统计

设计要点：
  * 同一份事实库同时渲染成两种布局，保证各实验臂的信息量一致。
  * dev / test 使用不同种子（不同的“世界”），改进版只允许在 dev 上迭代。
  * 判分全部是程序化规则（正则 / 句数 / 结尾），不依赖 LLM 评委。
"""
import argparse
import json
import random
import re
import shutil
from pathlib import Path

CHARS = list(dict.fromkeys("青松磐石星河远山明镜北辰云岫归燕清风朗月长天碧海孤帆流萤听雪寒江秋水落霞断鸿紫电苍梧玄武朱雀白泽"))
SURN = list("李王张刘陈杨赵黄周吴徐孙胡朱高林何郭马罗")
GIVEN = list("明芳伟静磊洋艳勇军杰娟涛超敏霞平刚丽强婷")
DEPTS = ["平台组", "数据组", "支付组", "风控组", "客服组", "运维组", "安全组", "增长组"]
ATTRS = ["负责人", "上线日期", "预算", "服务器端口", "数据库名", "评审日期", "测试负责人", "值班人"]
PERSON_ATTRS = {"负责人", "测试负责人", "值班人"}
DATE_ATTRS = {"上线日期", "评审日期"}
ASK = {
    "负责人": ("负责人是谁", "姓名"),
    "测试负责人": ("测试负责人是谁", "姓名"),
    "值班人": ("值班人是谁", "姓名"),
    "上线日期": ("上线日期是哪天", "日期"),
    "评审日期": ("评审日期是哪天", "日期"),
    "预算": ("预算是多少", "金额"),
    "服务器端口": ("服务器端口是多少", "数字"),
    "数据库名": ("数据库名是什么", "库名"),
}
BAD = {
    "负责人": "无名氏", "测试负责人": "无名氏", "值班人": "无名氏",
    "上线日期": "2030-01-01", "评审日期": "2030-01-01",
    "预算": "1万元", "服务器端口": "1234", "数据库名": "none_none_00",
}
SHARED = [
    "周报每周五 17:00 前提交。",
    "代码评审至少需要 1 人通过才能合并。",
    "线上变更窗口为周二、周四晚间。",
    "报销单需在发生后 30 天内提交。",
    "值班交接在每周一上午 10:00 进行。",
    "新人入职第一周需完成安全培训。",
]
ABSTAIN = ["没有记录", "未记录", "不知道", "不清楚", "没有找到", "未找到",
           "无法确认", "没有相关", "没有提到", "查不到", "不确定"]
INDEX_BUDGET = 4096  # 现版索引字节预算


def tok(v):
    """带数字边界的字面量正则，避免 '23万元' 误匹配 '123万元'。"""
    return rf"(?<![0-9]){re.escape(v)}(?![0-9])"


def alts(attr, v):
    if attr in DATE_ATTRS:
        y, m, d = map(int, v.split("-"))
        return [tok(v), tok(f"{y}年{m}月{d}日"), tok(f"{y}年{m:02d}月{d:02d}日"), tok(f"{y}/{m:02d}/{d:02d}")]
    if attr == "预算":
        n = int(v.replace("万元", ""))
        return [tok(f"{n}万元"), tok(f"{n}万"), tok(str(n * 10000))]
    return [tok(v)]


def question(e, attr, now=False):
    ask, ans = ASK[attr]
    if now:
        return f"{e}现在的{ask}？只回答最终{ans}，不要解释。"
    return f"{e}的{ask}？只回答{ans}，不要解释。"


# ---------------------------------------------------------------- 常驻规则
def rule_date(rng):
    y, m, d = rng.choice([2026, 2027]), rng.randint(1, 12), rng.randint(1, 28)
    iso = f"{y}-{m:02d}-{d:02d}"
    return ("date_fmt", "日期一律写成 YYYY-MM-DD 格式（例如 2026-03-05），不要用“x年x月x日”的写法。",
            f"帮我写一句会议通知：会议时间是{y}年{m}月{d}日。",
            {"must_all": [tok(iso)], "must_not": [tok(f"{y}年{m}月{d}日")]},
            f"会议时间：{iso}。", f"会议时间：{y}年{m}月{d}日。")


def rule_notable(rng):
    return ("no_table", "回复中不要使用 Markdown 表格。",
            "用对比的方式说明 PostgreSQL 和 MySQL 在主从复制上的区别。",
            {"must_not": [r"^\s*\|.*\|\s*$", r"\|\s*:?-{3,}"]},
            "PostgreSQL 基于 WAL 流复制，MySQL 基于 binlog 复制。",
            "| 项目 | PG | MySQL |\n|---|---|---|\n| 日志 | WAL | binlog |")


def rule_title(rng):
    t = rng.choice(["老师", "师兄", "博士", "教授"])
    return ("title", f"称呼用户为“{t}”。", "你好，帮我想一个周报的开头。",
            {"must_all": [re.escape(t)]}, f"{t}好，周报开头可以这样写：本周主要完成了……", "您好，周报开头可以这样写：本周主要完成了……")


def rule_amount(rng):
    amt = rng.randint(20, 900) * 10000
    n = amt // 10000
    return ("amount_unit", "金额一律以“万元”为单位表述，不要写成带千分位的元。",
            f"本季度预算是 {amt:,} 元，帮我写一句话向领导汇报。",
            {"must_all": [tok(f"{n}万元")], "must_not": [tok(str(amt))]},
            f"本季度预算为{n}万元。", f"本季度预算为{amt:,}元。")


def rule_sig(rng):
    sig = rng.choice(["【已核对】", "—— 小助手", "（完）"])
    return ("signature", f"每条回复的最后一行必须是“{sig}”。", "用一句话解释什么是幂等性。",
            {"endswith": sig}, f"幂等性指多次执行与一次执行的结果相同。\n{sig}", "幂等性指多次执行与一次执行的结果相同。")


def rule_filename(rng):
    return ("filename", "文件名一律使用小写字母加连字符，不要空格、下划线或大写。",
            "给“Q3 Revenue Report”这份文件起个文件名，只回答文件名。",
            {"must_all": [r"q3-revenue-report"], "must_not": [r"[A-Z_]"]},
            "q3-revenue-report.xlsx", "Q3_Revenue_Report.xlsx")


def rule_24h(rng):
    cn = {1: "一", 2: "二", 3: "三", 4: "四", 5: "五", 6: "六", 7: "七", 8: "八", 9: "九"}
    h, m = rng.randint(13, 21), rng.choice([0, 30])
    zh = f"下午{cn[h - 12]}点{'半' if m else ''}"
    return ("time_24h", "时间一律使用 24 小时制（如 15:30），不要写“下午三点半”这类说法。",
            f"把“{zh}”写进一句例会通知里。",
            {"must_all": [tok(f"{h}:{m:02d}")], "must_not": [r"下午", r"(?i)\bpm\b"]},
            f"例会改在 {h}:{m:02d} 开始。", f"例会改在{zh}开始。")


def rule_short(rng):
    return ("short_answer", "回答一律控制在两句话以内。", "介绍一下什么是缓存穿透。",
            {"max_sentences": 2}, "缓存穿透指查询不存在的数据而绕过缓存。这会让请求直达数据库。",
            "缓存穿透指查询不存在的数据。它会绕过缓存。请求会直达数据库。可能拖垮数据库。")


def rule_nolist(rng):
    return ("no_bullets", "回复中不要使用项目符号列表（不要以“- ”或“• ”开头分点）。",
            "列出提高 Web 服务稳定性的三个做法。",
            {"must_not": [r"^\s*[-•*]\s", r"^\s*\d+[\.、)]\s"]},
            "可以做限流降级，也可以做多副本部署，还可以做完善的监控告警。",
            "- 限流降级\n- 多副本部署\n- 监控告警")


RULE_DEFS = [rule_date, rule_notable, rule_title, rule_amount, rule_sig, rule_filename, rule_24h, rule_short, rule_nolist]


# ---------------------------------------------------------------- 世界
class World:
    def __init__(self, seed):
        self.rng = random.Random(seed)
        self.facts = []
        self.used = set()
        self.ent_names = set()
        self.entities = []
        self.persons = []
        self.person_facts = {}
        self.exts = set()
        self._n = 0

    def _id(self, p="f"):
        self._n += 1
        return f"{p}{self._n:05d}"

    def rdate(self):
        return f"2026-{self.rng.randint(1, 8):02d}-{self.rng.randint(1, 28):02d}"

    def add(self, entity, attr, value, topic="proj", hot=False, order=None):
        key = (entity, attr)
        assert key not in self.used, key
        self.used.add(key)
        date = self.rdate()
        f = {"id": self._id(), "scope": "channel", "kind": "fact", "topic": topic, "entity": entity,
             "attr": attr, "value": value, "date": date, "hot": hot,
             "order": self.rng.random() if order is None else order, "supersedes": None,
             "text": f"{entity}的{attr}：{value}（记于{date}）"}
        self.facts.append(f)
        return f

    def correct(self, f, prev, new, date, supersedes):
        c = {"id": self._id("c"), "scope": "channel", "kind": "correction", "topic": f["topic"],
             "entity": f["entity"], "attr": f["attr"], "value": new, "date": date, "hot": f["hot"],
             "order": None, "supersedes": supersedes,
             "text": f"【更正 {date}】{f['entity']}的{f['attr']}改为：{new}（原为{prev}）"}
        self.facts.append(c)
        return c

    def add_global(self, kind, text, **extra):
        f = {"id": self._id("g"), "scope": "global", "kind": kind, "text": text,
             "order": self.rng.random(), "hot": False}
        f.update(extra)
        self.facts.append(f)
        return f

    def new_person(self):
        while True:
            n = self.rng.choice(SURN) + self.rng.choice(GIVEN)
            if n not in self.person_facts:
                break
        while True:
            ext = str(self.rng.randint(1000, 9999))
            if ext not in self.exts:
                break
        self.exts.add(ext)
        self.persons.append(n)
        self.person_facts[n] = {}
        self.person_facts[n]["分机号"] = self.add(n, "分机号", ext, topic="people")
        self.person_facts[n]["所属部门"] = self.add(n, "所属部门", self.rng.choice(DEPTS), topic="people")
        return n

    def pick_person(self):
        if len(self.persons) < 10 or self.rng.random() < 0.12:
            return self.new_person()
        return self.rng.choice(self.persons)

    def value_for(self, attr, avoid=()):
        rng = self.rng
        while True:
            if attr in PERSON_ATTRS:
                v = self.pick_person()
            elif attr in DATE_ATTRS:
                v = f"{rng.choice([2026, 2027])}-{rng.randint(1, 12):02d}-{rng.randint(1, 28):02d}"
            elif attr == "预算":
                v = f"{rng.randint(20, 980)}万元"
            elif attr == "服务器端口":
                v = str(rng.randint(3000, 9999))
            else:
                v = f"{rng.choice(['ord', 'usr', 'pay', 'log', 'inv'])}_{rng.choice(['main', 'read', 'arch'])}_{rng.randint(1, 99):02d}"
            if v not in avoid:
                return v

    def make_entity(self, target=None, hot_target=False, target_order=None, exclude=(), hot_prob=0.0):
        while True:
            a, b = self.rng.sample(CHARS, 2)
            e = f"{a}{b}项目"
            if e not in self.ent_names:
                break
        self.ent_names.add(e)
        self.entities.append(e)
        pool = [a for a in ATTRS if a not in exclude]
        chosen = self.rng.sample(pool, self.rng.randint(5, min(7, len(pool))))
        if target and target not in chosen:
            chosen[-1] = target
        fs = {}
        for at in chosen:
            v = self.value_for(at)
            is_t = at == target
            hot = hot_target if is_t else (hot_prob > 0 and self.rng.random() < hot_prob)
            fs[at] = self.add(e, at, v, hot=hot, order=target_order if (is_t and target_order is not None) else None)
        return e, fs


def mono_bytes(w):
    return 60 + sum(len(f["text"].encode()) + 3 for f in w.facts if f["scope"] == "channel")


# ---------------------------------------------------------------- 渲染
def render_all(w, seed):
    r = random.Random(seed)
    F = w.facts
    ch_base = [f for f in F if f["scope"] == "channel" and f["kind"] == "fact"]
    ch_corr = [f for f in F if f["scope"] == "channel" and f["kind"] == "correction"]
    rules = [f for f in F if f["kind"] == "rule"]
    shared = [f for f in F if f["kind"] == "shared"]

    # ---- monolith（旧版布局）
    mono = ["# 频道记忆（MEMORY.md）", ""]
    mono += [f"- {f['text']}" for f in sorted(ch_base, key=lambda f: f["order"])]
    if ch_corr:
        mono += [""] + [f"- {f['text']}" for f in sorted(ch_corr, key=lambda f: f["date"])]
    mono_ch = "\n".join(mono) + "\n"
    g = ["# 全局记忆（MEMORY.md）", ""]
    g += [f"- {f['text']}" for f in sorted(rules + shared, key=lambda f: f["order"])]
    mono_gl = "\n".join(g) + "\n"

    # ---- index_notes（现版布局：追加式索引 + 笔记）
    ents = list(w.entities)
    r.shuffle(ents)
    ppl = list(w.persons)
    r.shuffle(ppl)
    notes = []
    for kind, keys_all, per, title in (("proj", ents, 10, "项目资料"), ("people", ppl, 14, "人员通讯录")):
        for k in range(0, len(keys_all), per):
            i = k // per + 1
            notes.append({"slug": f"{kind}-{i:02d}", "title": f"{title} {i:02d}",
                          "keys": keys_all[k:k + per], "order": r.random()})
    key2note = {key: n["slug"] for n in notes for key in n["keys"]}

    note_text = {}
    for n in notes:
        ks = set(n["keys"])
        base = [f for f in ch_base if f["entity"] in ks and not f["hot"]]
        corr = [f for f in ch_corr if f["entity"] in ks and not f["hot"]]
        lines = [f"# {n['title']}", ""] + [f"- {f['text']}" for f in sorted(base, key=lambda f: f["order"])]
        if corr:
            lines += [""] + [f"- {f['text']}" for f in sorted(corr, key=lambda f: f["date"])]
        note_text[n["slug"]] = "\n".join(lines) + "\n"

    items = [(f["order"], f"- {f['text']}", f["id"]) for f in ch_base if f["hot"]]
    items += [(n["order"], f"- {n['title']}：{'、'.join(n['keys'])} → memory/{n['slug']}.md", "note:" + n["slug"])
              for n in notes]
    items.sort(key=lambda t: t[0])
    tail = [(None, f"- {f['text']}", f["id"]) for f in sorted((c for c in ch_corr if c["hot"]), key=lambda c: c["date"])]
    idx_lines = ["# 频道记忆索引（常驻；细节见 memory/ 下的笔记）", ""]
    keys = [None, None]
    for _, line, key in items + tail:
        idx_lines.append(line)
        keys.append(key)
    ends, pos = {}, 0
    for line, key in zip(idx_lines, keys):
        end = pos + len(line.encode())
        if key:
            ends[key] = end
        pos = end + 1
    index_ch = "\n".join(idx_lines) + "\n"

    # ---- 全局索引
    inline = [f for f in rules if f["placement"] == "inline"]
    linked = [f for f in rules if f["placement"] == "linked"]
    gl_items = sorted(inline + shared, key=lambda f: f["order"])
    gl_lines = ["# 全局记忆索引（常驻）", ""] + [f"- {f['text']}" for f in gl_items]
    gl_keys = [None, None] + [f["id"] for f in gl_items]
    shared_notes = {}
    if linked:
        gl_lines.append("- 写作与格式规范 → .shared/memory/style-guide.md")
        gl_keys.append("note:style-guide")
        shared_notes["style-guide"] = "\n".join(["# 写作与格式规范", ""] + [f"- {f['text']}" for f in linked]) + "\n"
    gends, pos = {}, 0
    for line, key in zip(gl_lines, gl_keys):
        end = pos + len(line.encode())
        if key:
            gends[key] = end
        pos = end + 1
    index_gl = "\n".join(gl_lines) + "\n"

    loc = {}
    for f in ch_base + ch_corr:
        loc[f["id"]] = "index" if f["hot"] else key2note[f["entity"]]
    for f in rules:
        loc[f["id"]] = "index" if f["placement"] == "inline" else "style-guide"
    return {"mono_ch": mono_ch, "mono_gl": mono_gl, "index_ch": index_ch, "index_gl": index_gl,
            "notes": note_text, "shared_notes": shared_notes, "loc": loc, "ends": ends, "gends": gends,
            "n_notes": len(notes)}


def wr(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


# ---------------------------------------------------------------- 构造夹具与题目
def build_fixture(size_kib, split, seed, out):
    w = World(seed)
    rng = w.rng
    fid = f"fx{size_kib:03d}k-{split}"
    cases = []
    counters = {}

    def case(cat, q, check, golden, bad, fact_ids, **meta):
        counters[cat] = counters.get(cat, 0) + 1
        cases.append({"id": f"{fid}-{cat}-{counters[cat]:02d}", "fixture": fid, "split": split,
                      "size_kib": size_kib, "category": cat, "question": q, "check": check,
                      "golden": golden, "bad": bad, "facts": fact_ids, "meta": meta})

    # 全局：规则 + 共享约定
    picked = rng.sample(RULE_DEFS, 5)
    rule_cases = []
    for j, fn in enumerate(picked):
        rid, text, prompt, check, golden, bad = fn(rng)
        placement = "inline" if j < 3 else "linked"
        rf = w.add_global("rule", f"【规则】{text}", rid=rid, placement=placement)
        rule_cases.append((rf, prompt, check, golden, bad, rid, placement))
    for t in rng.sample(SHARED, 4):
        w.add_global("shared", f"【约定】{t}")

    for _ in range(10):
        w.new_person()

    ASK_ATTRS = ["负责人", "上线日期", "预算", "服务器端口", "数据库名", "评审日期"]

    # index_hit：热点事实（现版放在索引里）
    for _ in range(4):
        at = rng.choice(ASK_ATTRS)
        e, fs = w.make_entity(target=at, hot_target=True, target_order=rng.uniform(0.1, 0.9))
        f = fs[at]
        case("index_hit", question(e, at), {"must_any": alts(at, f["value"])}, f["value"], BAD[at], [f["id"]], hot=True)
    # note_needed：只在笔记里的事实
    for _ in range(4):
        at = rng.choice(ASK_ATTRS)
        e, fs = w.make_entity(target=at)
        f = fs[at]
        case("note_needed", question(e, at), {"must_any": alts(at, f["value"])}, f["value"], BAD[at], [f["id"]], hot=False)
    # multi_hop：项目 -> 负责人 -> 分机号
    for _ in range(3):
        e, fs = w.make_entity(target="负责人")
        x = fs["负责人"]["value"]
        ext = w.person_facts[x]["分机号"]
        case("multi_hop", f"{e}的负责人的分机号是多少？只回答数字，不要解释。", {"must_any": [tok(ext["value"])]},
             ext["value"], "0000", [fs["负责人"]["id"], ext["id"]], hops=2)
    # abstain：实体存在但该属性没有记录；另一实体有该属性（近似干扰）
    for at in ["测试负责人", "评审日期", "数据库名"]:
        e, fs = w.make_entity(exclude=(at,))
        e2, fs2 = w.make_entity(target=at)
        v2 = fs2[at]["value"]
        case("abstain", question(e, at),
             {"must_any": [re.escape(k) for k in ABSTAIN], "must_not": alts(at, v2)},
             "没有记录。", v2, [f["id"] for f in fs.values()], distractor=v2)
    # update：被更正过的事实（2 热点 + 2 非热点；其中一条更正两次）
    two = rng.randrange(4)
    for i, hot in enumerate([True, True, False, False]):
        at = rng.choice(["负责人", "上线日期", "预算", "服务器端口"])
        e, fs = w.make_entity(target=at, hot_target=hot, target_order=rng.uniform(0.1, 0.9) if hot else None)
        f = fs[at]
        versions, ids, sup = [f["value"]], [f["id"]], f["id"]
        for c in range(2 if i == two else 1):
            nv = w.value_for(at, avoid=versions)
            corr = w.correct(f, versions[-1], nv, f"2026-{9 + c:02d}-{rng.randint(1, 28):02d}", sup)
            versions.append(nv)
            ids.append(corr["id"])
            sup = corr["id"]
        stale = [p for s in versions[:-1] for p in alts(at, s)]
        case("update", question(e, at, now=True), {"must_any": alts(at, versions[-1]), "must_not": stale},
             versions[-1], versions[0], ids, hot=hot, n_corrections=len(versions) - 1)
    # position：同一类热点事实放在文件头 / 中 / 尾
    for pos, order in (("head", 0.03), ("mid", 0.50), ("tail", 0.97)):
        at = rng.choice(ASK_ATTRS)
        e, fs = w.make_entity(target=at, hot_target=True, target_order=order)
        f = fs[at]
        case("position", question(e, at), {"must_any": alts(at, f["value"])}, f["value"], BAD[at], [f["id"]],
             position=pos, order=order)
    # irrelevant：与记忆无关
    for _ in range(3):
        a, b = rng.randint(12, 99), rng.randint(12, 99)
        case("irrelevant", f"请计算 {a}×{b}，只给出结果。", {"must_any": [tok(str(a * b))]}, str(a * b), str(a * b + 1), [])
    # implicit_rule：必须隐式遵循的常驻规则
    for rf, prompt, check, golden, bad, rid, placement in rule_cases:
        case("implicit_rule", prompt, check, golden, bad, [rf["id"]], rule=rid, placement=placement)

    # 填充到目标体量（填充事实 4% 概率标为热点）
    while mono_bytes(w) < size_kib * 1024:
        w.make_entity(hot_prob=0.04)

    R = render_all(w, seed + 1)
    fb = {f["id"]: f for f in w.facts}
    cut_total = 0
    for c in cases:
        reads, cut = set(), False
        for fid_ in c["facts"]:
            f = fb[fid_]
            where = R["loc"][fid_]
            if f["scope"] == "global":
                ends, key = R["gends"], (fid_ if where == "index" else "note:" + where)
            else:
                ends, key = R["ends"], (fid_ if where == "index" else "note:" + where)
            if where != "index":
                reads.add(where)
            if ends.get(key, 0) > INDEX_BUDGET:
                cut = True
        c["meta"]["gold_reads_s1"] = sorted(reads)
        c["meta"]["s1_index_cut"] = cut
        cut_total += cut

    root = out / "fixtures" / fid
    wr(root / "facts.json", json.dumps({"facts": w.facts, "entities": w.entities, "persons": w.persons},
                                       ensure_ascii=False, separators=(",", ":")))
    wr(root / "monolith" / "MEMORY.md", R["mono_gl"])
    wr(root / "monolith" / "channel" / "MEMORY.md", R["mono_ch"])
    wr(root / "index_notes" / "MEMORY.md", R["index_gl"])
    wr(root / "index_notes" / "channel" / "MEMORY.md", R["index_ch"])
    for slug, t in R["notes"].items():
        wr(root / "index_notes" / "channel" / "memory" / f"{slug}.md", t)
    for slug, t in R["shared_notes"].items():
        wr(root / "index_notes" / ".shared" / "memory" / f"{slug}.md", t)

    stat = {"fixture": fid, "split": split, "size_kib": size_kib, "facts": sum(f["kind"] == "fact" for f in w.facts),
            "corrections": sum(f["kind"] == "correction" for f in w.facts),
            "hot": sum(bool(f.get("hot")) and f["kind"] == "fact" for f in w.facts),
            "notes": R["n_notes"], "channel_monolith_bytes": len(R["mono_ch"].encode()),
            "global_monolith_bytes": len(R["mono_gl"].encode()),
            "channel_index_bytes": len(R["index_ch"].encode()), "global_index_bytes": len(R["index_gl"].encode()),
            "channel_index_over_budget": len(R["index_ch"].encode()) > INDEX_BUDGET,
            "cases": len(cases), "cases_cut_in_s1_index": cut_total}
    return cases, stat


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="testset")
    ap.add_argument("--sizes", default="12,32,64,128", help="频道 MEMORY.md（旧版布局）的目标体量，单位 KiB")
    ap.add_argument("--seed-base", type=int, default=7000)
    a = ap.parse_args()
    out = Path(a.out)
    if out.exists():
        shutil.rmtree(out)
    allc, stats = [], []
    for s in [int(x) for x in a.sizes.split(",")]:
        for split, off in (("dev", 0), ("test", 5)):
            c, st = build_fixture(s, split, a.seed_base + s * 10 + off, out)
            allc += c
            stats.append(st)
    wr(out / "cases.jsonl", "".join(json.dumps(c, ensure_ascii=False) + "\n" for c in allc))
    wr(out / "stats.json", json.dumps(stats, ensure_ascii=False, indent=2))
    print(f"cases={len(allc)} fixtures={len(stats)} -> {out}")


if __name__ == "__main__":
    main()
