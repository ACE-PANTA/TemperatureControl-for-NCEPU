# 温控系统外部接口总览

本文档面向两类调用方：

- 普通软件：通过 HTTP 或 WebSocket 调用本系统。
- MCP 大模型客户端：通过 MCP JSON-RPC 工具调用本系统。

系统启动后会在本机开放：

- HTTP API: `http://127.0.0.1:8056`
- MCP Endpoint: `http://127.0.0.1:8056/mcp`
- WebSocket: `ws://127.0.0.1:8057`

首页顶部状态栏显示 `外部接口 8056/8057 正常` 时，说明 HTTP、WebSocket、MCP 服务均已启动。

## 配套规范文件

- HTTP/OpenAPI 规范：[openapi.yaml](./openapi.yaml)
- MCP 工具清单：[mcp-tools.json](./mcp-tools.json)

建议第三方系统优先读取 `openapi.yaml`。建议 MCP 客户端或大模型读取 `mcp-tools.json`，其中包含工具名称、用途、参数 schema、示例和注意事项。

## 启动验证

```bash
curl http://127.0.0.1:8056/health
```

成功示例：

```json
{
  "ok": true,
  "services": {
    "http": { "port": 8056, "running": true, "error": "" },
    "websocket": { "port": 8057, "running": true, "error": "", "clients": 0 },
    "mcp": { "port": 8056, "path": "/mcp", "running": true, "error": "" },
    "renderer": { "ready": true, "lastSnapshotAt": 1710000000000 }
  }
}
```

判断规则：

- `services.http.running === true`: HTTP API 可用。
- `services.websocket.running === true`: WebSocket 广播可用。
- `services.mcp.running === true`: MCP Endpoint 可用。
- `services.renderer.ready === true`: UI 运行态已接入，外部命令可以转发到真实控制逻辑。

## 快照模型

`snapshot` 是对外统一状态快照。HTTP、WebSocket、MCP 返回的状态都基于该结构。

关键字段：

- `connection.primaryChannel`: 当前主通道，可能为 `serial`、`ethernet` 或 `null`。
- `connection.serial.connected`: 串口是否连接。
- `connection.ethernet.connected`: 网口是否连接。
- `controller.mode`: 当前控制模式，`AUTO` 为自动，`MAN` 为手动。
- `controller.phase`: 当前工况，`MAN`、`TRAN` 或 `FINE`。
- `controller.pwm`: 当前 PWM 输出。
- `controller.targetTemperature`: 目标温度。
- `controller.feedbackTemperature`: 反馈温度。
- `pid.tran`: 变温工况 PID 参数。
- `pid.fine`: 微调工况 PID 参数。
- `pid.deadband`: 共享死区。
- `pid.fineEnabled`: 是否允许进入微调工况。
- `sample.primary`: 当前主通道实时采样。
- `services`: 外部服务状态。

## HTTP API

HTTP API 适合被普通软件、脚本、上位系统调用。请求和响应均为 JSON。

| Method | Path | 用途 |
|---|---|---|
| `GET` | `/health` | 服务健康检查 |
| `GET` | `/api/status` | 查询外部服务状态 |
| `GET` | `/api/snapshot` | 查询最近一次系统快照 |
| `POST` | `/api/refresh` | 主动查询设备并刷新快照 |
| `POST` | `/api/mode` | 切换自动/手动模式 |
| `POST` | `/api/manual-pwm` | 下发手动 PWM |
| `POST` | `/api/target-temperature` | 下发自动模式目标温度 |
| `POST` | `/api/pid/tran` | 下发变温工况 PID |
| `POST` | `/api/pid/fine` | 下发微调工况 PID |
| `POST` | `/api/pid/deadband` | 下发共享死区 |
| `POST` | `/api/pid/fine-enable` | 启用或禁用微调工况 |
| `POST` | `/api/save` | 保存当前设备配置 |

所有下发类接口都支持可选字段：

```json
{
  "channel": "serial"
}
```

`channel` 可选值：

- `serial`: 通过串口下发。
- `ethernet`: 通过网口下发。
- 不传：使用当前主通道。

### 常用 HTTP 示例

读取快照：

```bash
curl http://127.0.0.1:8056/api/snapshot
```

切换自动模式：

```bash
curl -X POST http://127.0.0.1:8056/api/mode ^
  -H "content-type: application/json" ^
  -d "{\"mode\":\"AUTO\",\"channel\":\"serial\"}"
```

切换手动模式并下发 PWM：

```bash
curl -X POST http://127.0.0.1:8056/api/mode ^
  -H "content-type: application/json" ^
  -d "{\"mode\":\"MAN\"}"

curl -X POST http://127.0.0.1:8056/api/manual-pwm ^
  -H "content-type: application/json" ^
  -d "{\"pwm\":35}"
```

下发目标温度：

```bash
curl -X POST http://127.0.0.1:8056/api/target-temperature ^
  -H "content-type: application/json" ^
  -d "{\"temperature\":58.0}"
```

下发变温工况 PID：

```bash
curl -X POST http://127.0.0.1:8056/api/pid/tran ^
  -H "content-type: application/json" ^
  -d "{\"kp\":3.0,\"ki\":0.3,\"kd\":1.0,\"interval\":3,\"sepThreshold\":10}"
```

下发微调工况 PID：

```bash
curl -X POST http://127.0.0.1:8056/api/pid/fine ^
  -H "content-type: application/json" ^
  -d "{\"kp\":1.5,\"ki\":0.1,\"kd\":2.0,\"interval\":8,\"range\":5,\"entryMin\":1,\"entryMax\":3,\"stableWindow\":10,\"stableDelta\":0.3}"
```

开启微调工况并保存：

```bash
curl -X POST http://127.0.0.1:8056/api/pid/fine-enable ^
  -H "content-type: application/json" ^
  -d "{\"enabled\":true}"

curl -X POST http://127.0.0.1:8056/api/save ^
  -H "content-type: application/json" ^
  -d "{}"
```

## WebSocket API

连接地址：

```text
ws://127.0.0.1:8057
```

连接后会立即收到两类消息：

- `service_status`: 外部服务状态。
- `snapshot`: 最新系统快照。

后续只要温度采样、控制器状态或 PID 配置变化，系统会广播新的 `snapshot` 到所有 WebSocket 客户端。

广播消息格式：

```json
{
  "type": "snapshot",
  "payload": {},
  "timestamp": 1710000000000
}
```

WebSocket 也支持发送控制命令：

```json
{
  "id": "req-1",
  "action": "set_target_temperature",
  "payload": {
    "temperature": 58.0,
    "channel": "serial"
  }
}
```

可用 `action`：

- `refresh_snapshot`
- `set_mode`
- `set_manual_pwm`
- `set_target_temperature`
- `set_tran_pid`
- `set_fine_pid`
- `set_deadband`
- `set_fine_enable`
- `save_config`

## MCP API

MCP Endpoint：

```text
POST http://127.0.0.1:8056/mcp
```

当前实现为 JSON-RPC over HTTP，支持：

- `initialize`
- `tools/list`
- `tools/call`
- `notifications/initialized`

### MCP 初始化

```bash
curl -X POST http://127.0.0.1:8056/mcp ^
  -H "content-type: application/json" ^
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{}}"
```

### 获取工具列表

```bash
curl -X POST http://127.0.0.1:8056/mcp ^
  -H "content-type: application/json" ^
  -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\",\"params\":{}}"
```

### 调用工具

```bash
curl -X POST http://127.0.0.1:8056/mcp ^
  -H "content-type: application/json" ^
  -d "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"temperature_set_mode\",\"arguments\":{\"mode\":\"AUTO\",\"channel\":\"serial\"}}}"
```

## MCP 大模型调用建议

大模型在调用时应遵守以下顺序：

1. 先调用 `temperature_get_status` 或 `temperature_refresh_snapshot`，确认连接状态、当前模式和当前工况。
2. 如果要下发手动 PWM，先调用 `temperature_set_mode` 切到 `MAN`，再调用 `temperature_set_manual_pwm`。
3. 如果要设置目标温度，先调用 `temperature_set_mode` 切到 `AUTO`，再调用 `temperature_set_target_temperature`。
4. 如果要修改 PID，优先明确工况：`temperature_set_tran_pid` 修改变温工况，`temperature_set_fine_pid` 修改微调工况。
5. 如果要让参数掉电保持，HTTP 调用 `/api/save`；当前 MCP 工具层暂未暴露保存工具，可通过 HTTP 保存接口完成。

## 错误处理

常见失败原因：

- 未连接串口或网口：下发类接口会失败。
- `channel` 指定为 `serial` 但串口未连接。
- `channel` 指定为 `ethernet` 但网口未连接。
- 设备返回 `ACK=ERR`。
- UI 渲染进程尚未 ready，`services.renderer.ready` 为 `false`。
- 参数类型不正确，例如 `pwm` 不是数字。

HTTP 失败响应格式：

```json
{
  "ok": false,
  "error": "error message"
}
```

MCP 失败响应格式：

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "error": {
    "code": -32000,
    "message": "error message"
  }
}
```

## 安全边界

- HTTP/MCP/WebSocket 均只监听 `127.0.0.1`，默认仅允许本机访问。
- 外部命令不会绕过现有上位机状态管理，所有下发仍走原有串口/网口命令链路。
- 修改 PID 或控制输出前，应先确认设备已连接、工况正确、目标通道正确。
