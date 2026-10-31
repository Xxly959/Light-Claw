import json
import pathlib
import sys
import urllib.error
import urllib.request

credentials = json.loads(pathlib.Path(sys.argv[1]).read_text())
request = urllib.request.Request(credentials["baseUrl"] + "/models", headers={"Authorization": "Bearer " + credentials["apiKey"]})
try:
    with urllib.request.urlopen(request, timeout=30) as response:
        body = json.load(response)
        result = {"status": response.status, "availableModels": [item["id"] for item in body.get("data", [])],
                  "selectedModel": credentials["model"]}
        pathlib.Path(sys.argv[2]).write_text(json.dumps(result, indent=2) + "\n")
        print(json.dumps(result))
except urllib.error.HTTPError as error:
    print(json.dumps({"status": error.code, "message": "DeepSeek preflight failed; no credentials logged"}))
    raise SystemExit(1)
