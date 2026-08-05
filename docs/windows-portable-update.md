# Windows 便携版更新 SOP（本机）

本机日常装的是**便携版**，不是安装包：

| 项               | 路径 / 名字                             |
| ---------------- | --------------------------------------- |
| 仓库             | `E:\paseo-official`                     |
| 构建产物         | `packages/desktop/release/win-unpacked` |
| 便携安装目录     | `D:\Apps\Paseo-portable`                |
| 主程序           | `D:\Apps\Paseo-portable\Paseo.exe`      |
| 打包脚本         | `scripts/dev-portable.ps1`              |
| 等你关应用再同步 | `scripts/sync-portable-on-exit.ps1`     |
| 计划任务         | `PaseoPortableSync`（已装好，别删）     |

用户说「更新」「准备更新」「打一包便携」「合完主线再更新」时，**默认走本 SOP**，不要每次再问用哪种安装形态。

## 默认流程（边跑边打，关应用后自动换新）

便携版正在跑时，exe 被锁，不能直接同步。标准做法：

1. **只打包，不同步**（应用可以继续开着）
2. **挂上等待脚本**
3. **用户自己关便携 Paseo**
4. 脚本发现进程没了 → 同步文件 → 自动再打开

### 1. 打包（BuildOnly）

在仓库根目录：

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/dev-portable.ps1 -BuildOnly
```

脚本会：

1. `npm run build:app-deps`
2. `PASEO_WEB_PLATFORM=electron` 做 Expo web export
3. `electron-builder --dir` → `packages/desktop/release/win-unpacked`

成功后日志里会提示再挂 watcher。打包可能要十几分钟；可后台跑，盯 `.tmp-portable-build-now.out` 一类日志尾部。

### 2. 挂「关应用后自动同步并重启」

打包成功后立刻：

```powershell
schtasks /run /tn PaseoPortableSync
```

该任务实际执行：

```text
pwsh -NoProfile -WindowStyle Hidden -File "E:\paseo-official\scripts\sync-portable-on-exit.ps1"
```

`sync-portable-on-exit.ps1` 行为：

- 每 5 秒看 `D:\Apps\Paseo-portable\Paseo.exe` 是否还在跑
- 进程全灭后：`robocopy win-unpacked → D:\Apps\Paseo-portable /MIR`
- 默认 `-Relaunch`：同步完启动新的 `Paseo.exe`
- 默认最多等 60 分钟（超时写日志后退出）
- 日志：`E:\paseo-official\.tmp-portable-watcher.log`

### 3. 告诉用户

大白话即可，例如：

> 包打好了，已挂上自动更新。你方便时**关掉便携版 Paseo**，关掉后会自动拷新版本并重新打开。

不要替用户强杀进程（除非用户明确说可以关）。

## 应用已经关着时

可一次打完并同步（不挂等待）：

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/dev-portable.ps1
```

若便携版还在跑，脚本会直接报错退出——这时改用上面的 **BuildOnly + 计划任务**。

## 合并官方更新时的顺序

1. 暂存本地未提交改动（不要丢用户 WIP）
2. `git fetch origin` + `git merge origin/main`（当前功能分支）
3. 解冲突 → `npm install` → 关键依赖/声明文件 → typecheck
4. 恢复 WIP，再解一轮 stash 冲突
5. 再走本 SOP 打便携包（含未提交本地功能时，工作区改动会进构建）

合并冲突不要擅自砍本地功能；官方与本地能并存就两边都留。

## Agent 检查清单

- [ ] 确认便携路径是 `D:\Apps\Paseo-portable`，不是 6767 安装守护进程那套
- [ ] 应用在跑 → 必须 `-BuildOnly`，禁止硬同步
- [ ] 打包成功 → 必须 `schtasks /run /tn PaseoPortableSync`
- [ ] 向用户说明：**关应用后自动更新并打开**
- [ ] 不要重启官方/本机 `6767` 守护进程（除非用户明确要求）
- [ ] 不要把「计划任务已启动」说成「已经更新完」——更新发生在用户关应用之后

## 排错

| 现象                       | 处理                                                                |
| -------------------------- | ------------------------------------------------------------------- |
| 同步失败、exe 被锁         | 确认用户已关便携 Paseo；再查 watcher 日志                           |
| `PaseoPortableSync` 不存在 | 按 `sync-portable-on-exit.ps1` 重注册计划任务（隐藏窗口、独立进程） |
| 打包失败                   | 看构建日志；先 `npm run build:app-deps` / typecheck                 |
| 关了应用但没自动开         | 读 `.tmp-portable-watcher.log`；看 robocopy exit 是否 > 7           |
| 新功能没进包               | 确认改动在工作区或已提交，且 BuildOnly 在改完之后跑的               |

## 相关脚本

- `scripts/dev-portable.ps1` — 构建；`-BuildOnly` 跳过同步
- `scripts/sync-portable-on-exit.ps1` — 等退出 → 同步 → 可选重启
