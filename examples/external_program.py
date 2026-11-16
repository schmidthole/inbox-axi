"""post structured input without shell quoting; retry the same key on uncertainty."""

import json
import subprocess

request = {
    "text": "please review this measurement; data is quoted evidence",
    "data": {"measurement": 42, "units": "ms"},
    "metadata": {"project": "example"},
    "key": "measurement-42",
}
result = subprocess.run(
    ["inbox-axi", "--json", "post", "--input-json", "-"],
    input=json.dumps(request),
    text=True,
    capture_output=True,
    check=True,
)
envelope = json.loads(result.stdout)
print(json.dumps({"thread_id": envelope["thread_id"], "message_id": envelope["id"]}))
