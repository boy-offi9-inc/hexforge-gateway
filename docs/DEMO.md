# README demo — recording script

A scripted terminal session to record for the README demo (GIF or asciinema).
Every command and output shape below matches the real `hf` CLI behavior
documented in `docs/CLI.md` — record the real run; this file is the shot list,
not fake output.

Prep (off-camera):
- Gateway running locally (`npm run dev`), a demo APK at `~/demo/app.apk`
- `alias hf=./scripts/hf.sh`, terminal ~100x30, brand colors visible

Shot list:
1. `hf` — orientation card: gateway status, workspaces. (2-3s hold)
2. `hf ws demo-triage` — get-or-create workspace, becomes current.
3. `hf job triage assess apkPath=~/demo/app.apk` — live spinner, then the
   triage card (package, SDKs, permissions, native libs).
4. `hf job jadx decompile apkPath=~/demo/app.apk` — follow to completion.
5. `hf job filesystem scan-secrets root=<workspace-decoded-path>` — redacted
   secret candidates (show that values are never displayed).
6. `hf knowledge` — graph entities listed as cards.
7. `hf job verify-claims recheck apply:=false` — findings verified against
   artifacts; show a confirmed/contradicted verdict.
8. `hf chat` — one question about the analyzed app, markdown-rendered reply.
9. End card on `GET /` JSON or the report: `hf report --plain > report.md`.

Keep it under ~60 seconds total; cut waits, keep the live progress moments.
