import json
import subprocess
import sys

entries = json.load(open("build-docker/compile_commands.json"))
failed = []
for e in entries:
    if not e["file"].endswith((".cpp", ".cc")):
        continue
    cmd = e["command"]
    if " -c " not in cmd:
        cmd = f"clang++ -fsyntax-only {cmd.split(' -o ')[0]}"
    else:
        cmd = "clang++ -fsyntax-only " + cmd.split(" -o ")[0]
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if r.returncode != 0:
        failed.append((e["file"], r.stderr[-600:]))
    else:
        sys.stderr.write("OK " + e["file"] + "\n")

print(f"FAILED: {len(failed)}")
for f, err in failed:
    print("=== " + f)
    print(err)
