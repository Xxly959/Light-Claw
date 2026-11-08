#!/usr/bin/env python3
"""程序化判分器：所有实验臂必须使用同一份判分逻辑，不得自行改写。

用法：
    python scorer.py --selftest testset/cases.jsonl     # 校验每道题的 golden 必过、bad 必挂
    from scorer import score; score(case["check"], response_text) -> bool

check 规格（均可缺省）：
    must_all      每条正则都必须匹配
    must_any      至少一条正则匹配
    must_not      任何一条匹配即判错
    endswith      回复去掉末尾空白后必须以该字符串结尾
    max_sentences 按 。！？!?；; 和换行切分后，句数不得超过该值
"""
import json
import re
import sys


def normalize(s):
    s = s.strip()
    return re.sub(r"(?<=\d),(?=\d)", "", s)  # 去掉数字千分位逗号


def sentences(s):
    return [x for x in re.split(r"[。！？!?；;\n]+", s) if x.strip()]


def score(check, response):
    r = normalize(response or "")
    if not r:
        return False
    for p in check.get("must_all", []):
        if not re.search(p, r, re.M):
            return False
    anyp = check.get("must_any")
    if anyp and not any(re.search(p, r, re.M) for p in anyp):
        return False
    for p in check.get("must_not", []):
        if re.search(p, r, re.M):
            return False
    if "endswith" in check and not r.rstrip().endswith(check["endswith"]):
        return False
    if "max_sentences" in check and len(sentences(r)) > check["max_sentences"]:
        return False
    return True


def selftest(path):
    bad_cases = []
    n = 0
    for line in open(path, encoding="utf-8"):
        c = json.loads(line)
        n += 1
        if not score(c["check"], c["golden"]):
            bad_cases.append((c["id"], "golden 未通过"))
        if score(c["check"], c["bad"]):
            bad_cases.append((c["id"], "bad 却通过了"))
    print(f"checked {n} cases, problems={len(bad_cases)}")
    for x in bad_cases[:20]:
        print("  ", x)
    return not bad_cases


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--selftest":
        sys.exit(0 if selftest(sys.argv[2]) else 1)
    print(__doc__)
