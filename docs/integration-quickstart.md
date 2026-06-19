# 外部系统接入快速指南

## 1. 普通软件接入

适用场景：C#、Python、Java、Node.js、LabVIEW、PLC 网关、MES 或其他上位系统。

推荐顺序：

1. 调用 `GET /health`，确认服务启动。
2. 调用 `GET /api/snapshot`，读取当前模式、工况、温度、PWM 和 PID 参数。
3. 根据业务需要调用下发接口。
4. 如果参数需要掉电保持，调用 `POST /api/save`。

基础地址：

```text
http://127.0.0.1:8056
```

OpenAPI 规范：

```text
docs/openapi.yaml
```

### Python 示例

```python
import requests

base_url = "http://127.0.0.1:8056"

health = requests.get(f"{base_url}/health", timeout=3).json()
print(health)

snapshot = requests.get(f"{base_url}/api/snapshot", timeout=3).json()
print(snapshot["snapshot"]["controller"])

requests.post(
    f"{base_url}/api/mode",
    json={"mode": "AUTO", "channel": "serial"},
    timeout=5,
).raise_for_status()

requests.post(
    f"{base_url}/api/target-temperature",
    json={"temperature": 58.0, "channel": "serial"},
    timeout=5,
).raise_for_status()
```

### Node.js 示例

```js
const baseUrl = 'http://127.0.0.1:8056'

const health = await fetch(`${baseUrl}/health`).then((res) => res.json())
console.log(health)

const snapshot = await fetch(`${baseUrl}/api/snapshot`).then((res) => res.json())
console.log(snapshot.snapshot.controller)

await fetch(`${baseUrl}/api/pid/tran`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    kp: 3,
    ki: 0.3,
    kd: 1,
    interval: 3,
    sepThreshold: 10,
    channel: 'serial'
  })
})
```

## 2. 实时数据接入

适用场景：数据大屏、实时曲线、其他程序监听温度变化。

WebSocket 地址：

```text
ws://127.0.0.1:8057
```

连接后系统会立即推送：

- `service_status`
- `snapshot`

之后状态或采样变化时，会继续广播 `snapshot`。

### Node.js WebSocket 示例

```js
import WebSocket from 'ws'

const socket = new WebSocket('ws://127.0.0.1:8057')

socket.on('message', (raw) => {
  const message = JSON.parse(raw.toString())
  if (message.type === 'snapshot') {
    console.log(message.payload.controller)
  }
})
```

## 3. MCP 大模型接入

适用场景：让支持 MCP 的大模型客户端查询状态、下发模式、温度、PWM 或 PID 参数。

MCP Endpoint：

```text
http://127.0.0.1:8056/mcp
```

工具描述文件：

```text
docs/mcp-tools.json
```

推荐让 MCP 客户端读取 `mcp-tools.json`，或直接通过 `tools/list` 获取服务端实时工具列表。

### MCP 调用顺序

1. `initialize`
2. `tools/list`
3. `tools/call`

### 查询当前状态

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "temperature_get_status",
    "arguments": {}
  }
}
```

### 设置自动模式和目标温度

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "temperature_set_mode",
    "arguments": {
      "mode": "AUTO",
      "channel": "serial"
    }
  }
}
```

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "temperature_set_target_temperature",
    "arguments": {
      "temperature": 58.0,
      "channel": "serial"
    }
  }
}
```

### 设置手动 PWM

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "tools/call",
  "params": {
    "name": "temperature_set_mode",
    "arguments": {
      "mode": "MAN",
      "channel": "serial"
    }
  }
}
```

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "tools/call",
  "params": {
    "name": "temperature_set_manual_pwm",
    "arguments": {
      "pwm": 35,
      "channel": "serial"
    }
  }
}
```

## 4. 注意事项

- 当前服务只监听本机 `127.0.0.1`。
- 只有上位机软件启动后，外部接口才存在。
- 只有设备通道已连接后，下发命令才会成功。
- `channel` 不传时使用当前主通道。
- WebSocket 推送的是上位机快照，不是设备原始串口帧。
