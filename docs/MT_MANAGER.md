# MT Manager APK MCP Setup

Setup for the `apkmcp` agent - HexForge's client for MT Manager's built-in
"APK MCP" service (Android only). Written against MT Manager's actual UI;
if your version's wording differs, [MT Manager's official
site](https://mt2.cn/) is the source of truth over this page.

Typical setup: Gateway (in Termux) and MT Manager run on the same phone and
talk over loopback. For the rest of the Android setup, see
[`SETUP.md`](SETUP.md#running-on-android-termux--mt-manager).

## 1. Find it

In MT Manager, open the tools/menu drawer. **APK MCP** sits between
**Terminal Simulator** and **Activity Record** (a paperclip-style icon):

![MT Manager tools menu showing APK MCP](images/mt-manager-tools-menu.jpg)

Tapping it opens the APK MCP dialog. Before the service starts, both
addresses read `Service not started`, and the buttons are **START**,
**SETTINGS**, **CLOSE**:

![APK MCP dialog before starting the service](images/mt-manager-apk-mcp-not-started.jpg)

## 2. Configure it (tap SETTINGS first)

Set these before your first **START** - the operation directory can't be
changed while APK MCP is running:

![APK MCP Settings screen](images/mt-manager-apk-mcp-settings.jpg)

| Setting | What to do |
|---|---|
| **MCP operation directory** | The root for every `path` the `apkmcp` agent sends. `open` / `list_available_apks` paths are **relative to this directory**; absolute paths are rejected ([details](AGENTS.md#apkmcp)). Point it at your APKs, e.g. `/storage/emulated/0/MT2/apks`. Tap `...` to browse. |
| **Enable floating ball** | **Turn this on** for anything beyond a quick one-off call. Off by default. See the note below. |
| **Port** | Default `8787`, matching the agent's default `baseUrl` (`http://127.0.0.1:8787/mcp`). Leave it unless you have a real conflict - changing it means setting `baseUrl` in every `apkmcp` task payload. |
| **Recently used workspaces to retain** | Default `5`. How many opened APKs MT keeps warm. Unrelated to HexForge workspaces - same name, different apps. |
| **APK SIGNING SETTINGS** | The key MT uses when `mt_apk_build` re-signs a rebuilt APK. Same key as MT Manager's own **Signing Key** tool. |

**Why the floating ball matters.** Android battery management can pause MT
Manager once it's backgrounded, which silently kills the MCP service. The
Gateway then gets a connection-refused error that looks like a HexForge
problem but isn't. The floating ball is MT's own workaround: a persistent
on-screen element that keeps the app (and APK MCP) alive in the
background. It is the most common reason `apkmcp` calls fail
intermittently on a real device. Its sub-option, *stick to the edge after
3s of inactivity*, is grayed out until the ball is enabled.

Tap **OK** to save.

## 3. Start it

Back on the APK MCP dialog, tap **START**. Both addresses populate, and
the buttons become **STOP**, **SETTINGS**, **CLOSE**:

![APK MCP dialog while the service is running](images/mt-manager-apk-mcp-running.jpg)

- **Local address** - `http://127.0.0.1:8787/mcp`. This is what the Gateway
  uses (same device, loopback), matching `apkmcp.agent.ts`'s default
  `baseUrl`.
- **LAN address** - one line per network interface, e.g.
  `http://192.168.x.x:8787/mcp`. Only relevant if the Gateway runs on a
  *different* device than MT Manager, which isn't the default setup.

## 4. Verify from HexForge

```bash
curl -X POST http://localhost:8080/workspaces/<id>/tasks \
  -H "Content-Type: application/json" \
  -d '{"agent": "apkmcp", "operation": "list_available_apks", "payload": {}}'
```

## Troubleshooting

| Symptom | Check |
|---|---|
| Connection refused, but APK MCP shows as running on the phone | Enable the **floating ball** (step 2) before debugging the Gateway config. |
| Path rejected on `open` | Use a path **relative** to the MCP operation directory; `list_available_apks` shows valid ones. |
| Can't change the operation directory | Tap **STOP** first - it's locked while the service runs. |
| Port changed and calls now fail | Set `baseUrl` in each `apkmcp` task payload, or set the port back to `8787`. |
