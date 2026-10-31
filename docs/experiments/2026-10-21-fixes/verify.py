import hashlib
import json
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parents[2]


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


old_count = 0
for folder in ['2026-10-21-ablation', '2026-10-21-diagnosis']:
    directory = ROOT.parent / folder
    for file, expected in json.loads((directory / 'artifact-hashes.json').read_text()).items():
        assert sha(directory / file) == expected, f'Historical artifact changed: {folder}/{file}'
        old_count += 1

before = json.loads((ROOT / 'before-manifest.json').read_text())
for file, expected in before.items():
    assert sha(ROOT / 'before' / file) == expected
changed = sorted(file for file, expected in before.items() if sha(REPO / file) != expected)
expected_changed = sorted([
    'packages/lightclaw/src/agent.ts',
    *[f'packages/lightclaw/src/evals/{file}.ts' for file in ['optimizer', 'optimize-cli', 'types', 'runner']],
    *[f'packages/lightclaw/test/{file}.test.ts' for file in ['runner-lifecycle', 'prompt-optimization', 'agent-runner', 'eval-runner']],
])
assert changed == expected_changed, changed
assert sha(ROOT / 'fixed-v2-agent.ts') == sha(REPO / 'packages/lightclaw/src/agent.ts')
assert sha(ROOT / 'fixed-v1-agent.ts') == json.loads((ROOT / 'fixed-v1-source.json').read_text())['agentSha256']

original = {case['id']: case for case in json.loads((ROOT.parent / '2026-10-21-ablation/prompt-dataset.json').read_text())}
dataset = {case['id']: case for case in json.loads((ROOT / 'prompt-dataset.json').read_text())}
assert all(case == original[case['id']] for case in dataset.values() if case['split'] == 'final')
assert '先删除数组中所有小于或等于0的元素' in dataset['select-space-path']['prompt']
all_rows, all_requests = [], []
tools_by_arm = {}
for mode, count, freeze_file in [('paired', 72, 'freeze.json'), ('followup', 18, 'followup-freeze.json'), ('aux', 5, 'aux-freeze.json')]:
    data_file = ROOT / ('aux-dataset.json' if mode == 'aux' else 'prompt-dataset.json')
    cases = {case['id']: case for case in json.loads(data_file.read_text())}
    freeze = json.loads((ROOT / 'raw' / freeze_file).read_text())
    assert freeze['datasetHash'] == sha(data_file)
    rows = [json.loads(line) for line in (ROOT / 'raw' / f'prompt-{mode}-runs.jsonl').read_text().splitlines()]
    requests = json.loads((ROOT / 'raw' / f'prompt-{mode}-requests.json').read_text())
    assert len(rows) == count
    assert sum(row['requests'] for row in rows) == len(requests)
    for index, row in enumerate(rows):
        assert row['runIndex'] == index
        item = cases[row['caseId']]
        arm = 'before' if '-before-' in row['label'] else 'fixed'
        assistant = [entry['message'] for entry in row['session'] if entry['type'] == 'message' and entry['message']['role'] == 'assistant']
        for key in ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens']:
            assert row['usage'][key] == sum(message['usage'][key] for message in assistant)
        assert row['usage']['totalTokens'] == sum(row['usage'][key] for key in ['input', 'output', 'cacheRead', 'cacheWrite'])
        expected_input = row['usage']['input'] + (0 if arm == 'before' else row['usage']['cacheRead'] + row['usage']['cacheWrite'])
        assert row['result']['run']['inputTokens'] == expected_input
        assert row['result']['run']['outputTokens'] == row['usage']['output']
        errors = [entry['message'] for entry in row['session'] if entry['type'] == 'message' and entry['message']['role'] == 'toolResult' and entry['message']['isError']]
        assert len(errors) == row['result']['run']['toolErrors']
        checks = row['result']['checks']
        assert row['result']['score'] == sum(check['passed'] for check in checks) / len(checks)
        assert row['success'] == all(check['passed'] for check in checks)
        for file, expected in item['outputs'].items():
            text = row['artifacts'][file]
            if 'json' in expected:
                assert json.loads(text) == expected['json']
            elif 'textExact' in expected:
                assert text == expected['textExact']
            else:
                assert text.strip() == expected['textTrimmed']
        assert all(check['passed'] for check in checks if check['name'].startswith('file_unchanged:'))
        selected = [request for request in requests if request['label']['runIndex'] == index]
        assert len(selected) == row['requests']
        for request in selected:
            payload = request['payload']
            assert payload['model'] == 'deepseek-flash'
            assert payload['temperature'] == .2 and payload['max_tokens'] == 2048
            assert payload['thinking'] == {'type': 'disabled'}
            names = sorted(tool['function']['name'] for tool in payload['tools'])
            tools_by_arm.setdefault(arm, names)
            assert tools_by_arm[arm] == names
            prompt = payload['messages'][0]['content']
            if arm == 'fixed':
                assert 'Current working directory: /workspace' in prompt
                assert '/Users/x/hermes-workspace/Light-Claw' not in prompt
                assert '.lightclaw-guide.md' in prompt
                assert 'apk add jq' not in prompt and 'Install packages as needed' not in prompt
                assert f"Channels: {row['channelId']}" in prompt
                if mode != 'paired':
                    assert 'Unavailable optional commands (checked): file' in prompt
        if row['caseId'] == 'aux-event-guide':
            events = row['artifacts']['localEvents']
            assert len(events) == 1 and events[0] == {'type': 'one-shot', 'channelId': row['channelId'], 'text': '检查复测报告', 'at': '2026-11-01T09:00:00+08:00'}
        if mode == 'aux' and row['caseId'].startswith('aux-'):
            calls = [block for message in assistant for block in message['content'] if block['type'] == 'toolCall']
            suffix = '.lightclaw-guide.md' if row['caseId'] == 'aux-event-guide' else 'skills/sum-three/SKILL.md'
            assert any(call['name'] == 'read' and call['arguments']['path'].endswith(suffix) for call in calls)
            if row['caseId'] == 'aux-installed-skill':
                assert any(call['name'] == 'bash' and 'python3 skills/sum-three/sum.py' in call['arguments']['command'] for call in calls)
    if mode != 'aux':
        counts = Counter((row['caseId'], '-before-' in row['label']) for row in rows)
        assert all(value == 3 for value in counts.values())
    all_rows += rows
    all_requests += requests

assert tools_by_arm['before'] == tools_by_arm['fixed'] and len(tools_by_arm['fixed']) == 7
assert len(all_requests) <= 450
tokens = sum(row['usage']['totalTokens'] for row in all_rows)
assert tokens <= 1200000
summary = json.loads((ROOT / 'summary.json').read_text())
assert summary['total'] == {'runs': 95, 'requests': len(all_requests), 'reportedTokens': tokens}
assert json.loads((ROOT / 'tests-result.json').read_text())['exitCode'] == 0
assert json.loads((ROOT / 'check-result.json').read_text())['exitCode'] == 0
assert '252 passed' in (ROOT / 'tests.log').read_text()
cleanup = json.loads((ROOT / 'cleanup.json').read_text())
assert cleanup['credentialAbsent'] and cleanup['temporaryWorkspaceAbsent'] and cleanup['containerRemoved']
result = {'passed': True, 'historicalHashesChecked': old_count, 'baselineFilesChecked': len(before), 'changedSourceAndTestFiles': changed, 'runs': len(all_rows), 'requests': len(all_requests), 'reportedTokens': tokens, 'sameSevenToolsPreserved': True, 'finalTasksUnchanged': True, 'currentAgentMatchesFixedV2': True}
(ROOT / 'verification.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(result, ensure_ascii=False, indent=2))
