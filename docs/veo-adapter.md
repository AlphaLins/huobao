# Veo 视频适配器接入文档

## 概述

为 Huobao 项目新增 Google Veo 视频生成适配器，通过 VIPStar 代理使用 OpenAI 兼容格式 `/v1/videos` 端点。

---

## 1. 新增文件

**`backend/src/services/adapters/veo-video.ts`**

实现 `VideoProviderAdapter` 接口，主要方法：

| 方法 | 功能 |
|------|------|
| `buildGenerateRequest()` | 构建 `POST /v1/videos` 请求，使用 `multipart/form-data` 格式 |
| `parseGenerateResponse()` | 解析响应，提取 `id` 作为异步 taskId |
| `buildPollRequest()` | 构建 `GET /v1/videos/{id}` 轮询请求 |
| `parsePollResponse()` | 解析状态 `queued/processing/completed/failed` |

**参考图支持：**
- 单图模式：`input_reference` 字段（支持 `file://` 本地路径或 HTTP URL）
- 尾帧模式：`last_image` 字段

---

## 2. 注册适配器

**`backend/src/services/adapters/registry.ts`**

```typescript
import { VeoVideoAdapter } from './veo-video'

export const videoAdapters: Record<string, VideoProviderAdapter> = {
  // ...
  veo: new VeoVideoAdapter(),
}
```

---

## 3. 数据库配置要求

`ai_service_configs` 表 video 配置行：

| 字段 | 值 | 说明 |
|------|-----|------|
| `service_type` | `video` | 必填 |
| `provider` | `veo` | **必须是小写**，代码按此匹配 `videoAdapters['veo']` |
| `base_url` | `https://vipstar.vip` | VIPStar 代理地址 |
| `model` | `["veo_3_1-fast-4K"]` | **必须是 JSON 数组格式** |
| `is_active` | `1` | 启用 |

---

## 4. 请求格式（VIPStar / OpenAI 视频格式）

```
POST /v1/videos
Content-Type: multipart/form-data
Authorization: Bearer {apiKey}

model: veo_3_1-fast-4K
prompt: <提示词>
seconds: 8
size: 16x9
watermark: false
input_reference: <file://路径或URL>
```

**尺寸字段格式：** `16x9` / `9x16` / `1x1`

---

## 5. 响应格式

**创建任务：**
```json
{
  "id": "video_55cb73b3-60af-40c8-95fd-eae8fd758ade",
  "object": "video",
  "model": "veo_3_1-fast-4K",
  "status": "queued",
  "progress": 0,
  "created_at": 1762336916,
  "seconds": "8",
  "size": "16x9"
}
```

**轮询完成：**
```json
{
  "id": "video_55cb73b3-...",
  "status": "completed",
  "video_url": "https://..."
}
```

---

## 6. 排查记录

### 问题 1：provider 不匹配

**现象：** 日志显示 `provider=openai`，请求去到 `/v1/video_generation`

**原因：** 数据库 `provider` 字段值为 `openai`，未改成 `veo`

**解决：**
```sql
UPDATE ai_service_configs SET provider = 'veo' WHERE service_type = 'video';
```

### 问题 2：模型名为 `v`

**现象：** 错误信息 `model v 无可用渠道`

**原因：** `model` 字段值格式错误，存成了 `"veo_3_1-fast-4K"`（字符串带多余双引号），`JSON.parse()` 解析后得到 `"veo_3_1-fast-4K"` 作为普通字符串，取 `models[0]` 时得到单个字符 `v`

**解决：**
```sql
UPDATE ai_service_configs SET model = '["veo_3_1-fast-4K"]' WHERE id = 3;
```

**验证：**
```javascript
const models = JSON.parse('["veo_3_1-fast-4K"]')  // → ["veo_3_1-fast-4K"]
models[0]  // → "veo_3_1-fast-4K" ✓
```

**错误示例：**
```javascript
const models = JSON.parse('"veo_3_1-fast-4K"')    // → "veo_3_1-fast-4K" (字符串)
models[0]  // → "v" (第一个字符!) ✗
```

---

## 7. 关键要点

1. **provider 必须小写** — `getVideoAdapter()` 内部做 `toLowerCase()` 后匹配
2. **model 必须是 JSON 数组** — 如 `["veo_3_1-fast-4K"]`，代码取 `models[0]`
3. **VIPStar 使用 form-data** — `video-generation.ts` 中对 FormData 不做 JSON.stringify
4. **参考图支持 file://** — 本地文件走 `fs.createReadStream` 上传