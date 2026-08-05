# 给 AI：帮用户在 Paseo 添加「服务器 Grok」

帮用户在本机 Paseo 加一个自定义提供商（套 Codex，走他自己的中转）。对用户说大白话。

---

## 先问用户要这三样（缺了别动手）

1. **中转地址**（完整 URL，常带 `/v1`）
2. **密钥**
3. **列表显示名**（用户不说就用：`服务器Grok(直连·24h)`）

可选：`CODEX_HOME` 路径。用户不会选就在他用户目录下新建 `paseo-grok-server-home`。

### 地址整理

- 去首尾空格
- 只有 `http://主机:端口`、没有 `/v1` 时，补成 `…/v1`
- 已有 `/v1` 不要重复加

### 密钥

- 去首尾空格
- 回复里不要完整复述密钥，写「已写入」即可

### 路径（Windows）

- JSON 里用双反斜杠：`C:\\Users\\张三\\paseo-grok-server-home`
- 目录不存在就创建
- 不要指向用户正在用的正式 Codex 主目录

### 前置

- 已装 Paseo
- 本机能用 Codex（`extends: "codex"`）
- 用户网络能访问他自己给的地址

---

## 步骤

### 1. 让用户退出 Paseo

窗口关干净，托盘也退出。

### 2. 配置文件位置

- Windows：`%USERPROFILE%\.paseo\config.json`
- macOS / Linux：`~/.paseo/config.json`

没有这个文件：让用户先开一次 Paseo 再退出。

### 3. 备份

复制一份，例如：

`config.json.backup-before-add-grok-server-YYYYMMDD-HHMMSS`

### 4. 改配置

用 JSON 解析后改，不要手搓括号。

目标：`agents.providers`

- 没有 `agents` / `providers` 就补空对象，别删用户已有字段
- 默认 key：`grok-server`（已存在就用 `grok-server-2` 并告诉用户）

写入内容（替换成用户给的真实值）：

```json
{
  "extends": "codex",
  "label": "服务器Grok(直连·24h)",
  "description": "经用户服务器中转直连 Grok；独立 Codex 目录",
  "env": {
    "OPENAI_BASE_URL": "用户给的中转地址",
    "OPENAI_API_KEY": "用户给的密钥",
    "CODEX_HOME": "本机独立目录路径"
  },
  "models": [
    {
      "id": "grok-4.5",
      "label": "Grok 4.5",
      "isDefault": true,
      "thinkingOptions": [
        { "id": "xhigh", "label": "xhigh", "description": "Extra high reasoning effort" },
        {
          "id": "high",
          "label": "high",
          "description": "High reasoning effort",
          "isDefault": true
        },
        { "id": "medium", "label": "medium", "description": "Medium reasoning effort" },
        { "id": "low", "label": "low", "description": "Low reasoning effort" }
      ]
    },
    {
      "id": "grok-4.3",
      "label": "Grok 4.3",
      "thinkingOptions": [
        { "id": "xhigh", "label": "xhigh", "description": "Extra high reasoning effort" },
        {
          "id": "high",
          "label": "high",
          "description": "High reasoning effort",
          "isDefault": true
        },
        { "id": "medium", "label": "medium", "description": "Medium reasoning effort" },
        { "id": "low", "label": "low", "description": "Low reasoning effort" }
      ]
    },
    {
      "id": "grok-composer-2.5-fast",
      "label": "Composer 2.5 Fast",
      "thinkingOptions": [
        { "id": "xhigh", "label": "xhigh", "description": "Extra high reasoning effort" },
        {
          "id": "high",
          "label": "high",
          "description": "High reasoning effort",
          "isDefault": true
        },
        { "id": "medium", "label": "medium", "description": "Medium reasoning effort" },
        { "id": "low", "label": "low", "description": "Low reasoning effort" }
      ]
    },
    {
      "id": "grok-build-0.1",
      "label": "Grok Build 0.1",
      "thinkingOptions": [
        { "id": "xhigh", "label": "xhigh", "description": "Extra high reasoning effort" },
        {
          "id": "high",
          "label": "high",
          "description": "High reasoning effort",
          "isDefault": true
        },
        { "id": "medium", "label": "medium", "description": "Medium reasoning effort" },
        { "id": "low", "label": "low", "description": "Low reasoning effort" }
      ]
    },
    {
      "id": "grok-4.20-0309-reasoning",
      "label": "Grok 4.20 Reasoning",
      "thinkingOptions": [
        { "id": "xhigh", "label": "xhigh", "description": "Extra high reasoning effort" },
        {
          "id": "high",
          "label": "high",
          "description": "High reasoning effort",
          "isDefault": true
        },
        { "id": "medium", "label": "medium", "description": "Medium reasoning effort" },
        { "id": "low", "label": "low", "description": "Low reasoning effort" }
      ]
    },
    {
      "id": "grok-3-mini",
      "label": "Grok 3 Mini",
      "thinkingOptions": [
        { "id": "xhigh", "label": "xhigh", "description": "Extra high reasoning effort" },
        {
          "id": "high",
          "label": "high",
          "description": "High reasoning effort",
          "isDefault": true
        },
        { "id": "medium", "label": "medium", "description": "Medium reasoning effort" },
        { "id": "low", "label": "low", "description": "Low reasoning effort" }
      ]
    }
  ],
  "enabled": true
}
```

用户只要先通一个模型时，`models` 只留 `grok-4.5` 即可。

写回 UTF-8，再解析一遍确认合法；坏了就从备份还原。

### 5. 让用户验收

1. 打开 Paseo
2. 新建 Agent，列表里有刚设的显示名
3. 能看到模型（完整版约 6 个）
4. 发「你好」能回就算成

你自动可查：条目在不在、`enabled`、三项 env 非空、`CODEX_HOME` 目录在不在。对话通不通以实际测到的为准。

---

## 对用户开场可以这样说

> 我帮你在 Paseo 里加「服务器 Grok」。需要你自己的：  
> 1）中转地址  
> 2）密钥  
> 3）想显示的名字（可默认：服务器Grok(直连·24h)）  
> 发给我之后我再改配置。

---

## 出问题怎么处理

| 情况             | 做法                                      |
| ---------------- | ----------------------------------------- |
| 列表没有         | 查文件路径、JSON 是否坏了、是否没退出就改 |
| 有提供商但聊不了 | 对用户给的地址/密钥、网络、本机 Codex     |
| 配置改坏         | 备份还原后再来                            |
| 只有密钥没有地址 | 让用户问他的管理员要地址                  |

---

## 原理（自己看，别念给用户）

`agents.providers` 里 `extends: "codex"`，用 `OPENAI_BASE_URL` + `OPENAI_API_KEY` 指到 OpenAI 兼容中转。这和设置里登录官方 Grok 账号不是一条路。仓库文档：`docs/custom-providers.md`。

---

## 做完跟用户说啥

- 已加上，显示名是什么
- 备份在哪
- 让他重启 Paseo → 选这个提供商 → 发「你好」试
- 若没试对话，写明还没验证能不能聊
