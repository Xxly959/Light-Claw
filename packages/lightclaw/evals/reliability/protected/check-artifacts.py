"""Trusted read-only oracle. Only stdout is written; never executes artifact content."""
import hashlib
import json
import runpy
import sys
reader = runpy.run_path(sys.argv[1])["read_attachment"]
request = json.load(sys.stdin)
root, channel = request["root"], request["channel"]

def read(path):
    return reader(root, channel, path, 1024 * 1024)

def object_without_duplicates(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result

def invalid_constant(value):
    raise ValueError("nonfinite JSON number")

def canonical(value):
    if isinstance(value, dict):
        return ("object", sorted((k, canonical(v)) for k, v in value.items()))
    if isinstance(value, list):
        return ("array", [canonical(v) for v in value])
    if isinstance(value, bool):
        return ("boolean", value)
    if isinstance(value, (int, float)):
        return ("number", value)
    return (type(value).__name__, value)

preserved = True
for path, expected in request["inputHashes"].items():
    try:
        preserved = preserved and hashlib.sha256(read(path)).hexdigest() == expected
    except (OSError, ValueError):
        preserved = False
expected = request["oracle"]["expected"]
artifact = business = None
if expected is not None:
    try:
        actual = json.loads(read(request["output"]), object_pairs_hook=object_without_duplicates, parse_constant=invalid_constant)
        artifact = canonical(actual) == canonical(expected)
        business = isinstance(actual, dict)
        inputs = json.loads(read("input.json"))
        for rule in request["oracle"]["constraints"]:
            kind = rule["kind"]
            if kind == "root-object":
                business = business and isinstance(actual, dict)
            elif kind == "unique":
                values = actual[rule["field"]]
                business = business and len(values) == len(set(map(json.dumps, values)))
            elif kind == "nonnegative":
                value = actual[rule["field"]]
                business = business and type(value) is int and value >= 0
            elif kind == "assignment-unique":
                allocation = actual["assignment"]
                business = business and set(allocation) == set(inputs["shifts"]) and len(set(allocation.values())) == len(allocation) and all(person in inputs["eligible"][shift] for shift, person in allocation.items())
            elif kind == "meeting-nonoverlap":
                lookup = {m["id"]:m for m in inputs["meetings"]}
                chosen = [lookup[i] for i in actual["chosen"]]
                business = business and all(a["end"] <= b["start"] for a,b in zip(chosen,chosen[1:]))
            elif kind == "capacity-order":
                lookup = {i["id"]: i["weight"] for i in inputs["items"]}
                boxes = actual["boxes"]
                business = business and [i for box in boxes for i in box] == [i["id"] for i in inputs["items"]] and all(sum(lookup[i] for i in box) <= inputs["capacity"] for box in boxes)
            else:
                raise ValueError("unknown business rule")
    except (OSError, ValueError, TypeError, KeyError):
        artifact = business = False
print(json.dumps({"artifactCorrect":artifact,"inputPreserved":preserved,"businessValid":business}))
