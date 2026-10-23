# MT Manager APK MCP tools

The tools MT Manager's built-in "APK MCP" service exposes, as reported by the
`tools/list` of an MT Manager build with **57** of them (from
[issue #16](https://github.com/boy-offi9-inc/hexforge-gateway/issues/16)). MT adds and
renames tools between releases, so for your own install run the `list_tools`
operation - it returns the live list with each tool's full argument schema:

```bash
curl -X POST http://localhost:8080/workspaces/<workspaceId>/tasks \
  -H "Content-Type: application/json" \
  -d '{"agent": "apkmcp", "operation": "list_tools"}'
```

The `apkmcp` agent has a convenience operation for seven of these (last column,
see [AGENTS](AGENTS.md#apkmcp)); everything else is reached with `call_tool`,
passing MT's argument shape explicitly. Three of the seven were renamed by MT
(`open`, `outline_class`, `close`), and the agent uses whichever name your MT
reports.

**Access** is MT's own annotation on the tool: *read-only* tools only look,
*writes* changes state without MT marking it destructive, and **destructive**
tools can overwrite or delete (including files outside any APK, for `mt_file_*`
and `mt_zip_*`). Only point the writing and destructive ones at apps and files you
own or are authorized to modify.

## APK tools (`mt_apk_*`) - 31

| Tool | MT's title | Access | HexForge operation |
|---|---|---|---|
| `mt_apk_workspace_open` | Open APK | read-only | `open` |
| `mt_apk_list_available_apks` | List Available APKs | read-only | `list_available_apks` |
| `mt_apk_workspace_list` | List APK Workspaces | read-only | `call_tool` |
| `mt_apk_list` | List APK Structures | read-only | `list` |
| `mt_apk_search` | Search APK | read-only | `search` |
| `mt_apk_read_text` | Read APK Text | read-only | `read_text` |
| `mt_apk_read_bytes` | Read APK Bytes | read-only | `call_tool` |
| `mt_apk_dex_read_class_outline` | Outline APK Dex Class | read-only | `outline_class` |
| `mt_apk_dex_xref` | Find APK Dex Xrefs | read-only | `call_tool` |
| `mt_apk_resource_read` | Read APK Resource | read-only | `call_tool` |
| `mt_apk_resource_xref` | Find APK Resource Xrefs | read-only | `call_tool` |
| `mt_apk_native_inspect` | Inspect Native ELF | read-only | `call_tool` |
| `mt_apk_native_list_items` | List Native ELF Items | read-only | `call_tool` |
| `mt_apk_native_map_address` | Map Native Address | read-only | `call_tool` |
| `mt_apk_native_xref` | Find Native Xrefs | read-only | `call_tool` |
| `mt_apk_native_disassemble` | Disassemble Native Bytes | read-only | `call_tool` |
| `mt_apk_native_analyze_control_flow` | Analyze Native Control Flow | read-only | `call_tool` |
| `mt_apk_continue` | Continue APK Cursor | read-only | `call_tool` |
| `mt_apk_session_create` | Create APK Edit Session | writes | `call_tool` |
| `mt_apk_edit_text` | Edit APK Text | writes | `call_tool` |
| `mt_apk_delete_target` | Delete APK Target | **destructive** | `call_tool` |
| `mt_apk_resource_edit` | Edit APK Resource | writes | `call_tool` |
| `mt_apk_resource_add` | Add APK Resource | writes | `call_tool` |
| `mt_apk_patch_bytes` | Patch APK Bytes | writes | `call_tool` |
| `mt_apk_native_patch_instructions` | Patch Native Instructions | writes | `call_tool` |
| `mt_apk_native_patch_string` | Patch Native UTF-8 String | writes | `call_tool` |
| `mt_apk_session_check` | APK Edit Session Check | writes | `call_tool` |
| `mt_apk_build` | Build APK | writes | `call_tool` |
| `mt_apk_workspace_delete` | Delete APK Workspace | writes | `close` |
| `mt_apk_read_signature` | Read APK Signature Details | read-only | `call_tool` |
| `mt_apk_copy_entry` | Copy APK Entry | **destructive** | `call_tool` |

## File tools (`mt_file_*`) - 19

| Tool | MT's title | Access | HexForge operation |
|---|---|---|---|
| `mt_file_get_access_policy` | Get File Access Policy | read-only | `call_tool` |
| `mt_file_list` | List Local Files | read-only | `call_tool` |
| `mt_file_stat` | Stat Local File | read-only | `call_tool` |
| `mt_file_read_text` | Read File Text | read-only | `call_tool` |
| `mt_file_read_bytes` | Read File Bytes | read-only | `call_tool` |
| `mt_file_edit_text` | Edit File Text | **destructive** | `call_tool` |
| `mt_file_write_bytes` | Write File Bytes | **destructive** | `call_tool` |
| `mt_file_patch_bytes` | Patch File Bytes | **destructive** | `call_tool` |
| `mt_file_copy` | Copy Local File | **destructive** | `call_tool` |
| `mt_file_move` | Move Local File | **destructive** | `call_tool` |
| `mt_file_delete` | Delete Local File | **destructive** | `call_tool` |
| `mt_file_create_directory` | Create Local Directory | writes | `call_tool` |
| `mt_file_delete_directory` | Delete Local Directory | **destructive** | `call_tool` |
| `mt_file_search` | Search Local Files | read-only | `call_tool` |
| `mt_file_replace_text` | Replace File Text | **destructive** | `call_tool` |
| `mt_file_truncate_bytes` | Truncate File Bytes | **destructive** | `call_tool` |
| `mt_file_append_bytes` | Append File Bytes | **destructive** | `call_tool` |
| `mt_file_append_text` | Append File Text | **destructive** | `call_tool` |
| `mt_file_search_text` | Search File Text | read-only | `call_tool` |

## Zip tools (`mt_zip_*`) - 7

| Tool | MT's title | Access | HexForge operation |
|---|---|---|---|
| `mt_zip_list` | List ZIP Entries | read-only | `call_tool` |
| `mt_zip_read_text` | Read ZIP Text | read-only | `call_tool` |
| `mt_zip_read_bytes` | Read ZIP Bytes | read-only | `call_tool` |
| `mt_zip_test` | Test ZIP Integrity | read-only | `call_tool` |
| `mt_zip_extract` | Extract ZIP | **destructive** | `call_tool` |
| `mt_zip_create` | Create ZIP | **destructive** | `call_tool` |
| `mt_zip_update` | Update ZIP | **destructive** | `call_tool` |

Totals: 30 read-only, 11 writes, 16 destructive.
