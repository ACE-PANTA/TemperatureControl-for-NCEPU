# 温控系统上位机

本项目是一个用于温度控制实验的桌面上位机程序，面向串口/网口设备连接、实时温度监控、PID 参数整定、CSV 数据记录以及外部系统集成等场景。

项目基于 Vue 3 与 Electron 构建：

- Vue 负责界面渲染、页面交互和状态管理。
- Electron 负责桌面应用封装、串口通信、文件读写、CSV 落盘和本机外部接口服务。

## 功能概览

- 实时显示温度曲线、目标温度、控制输出和运行状态。
- 支持串口设备扫描、连接、断开和命令下发。
- 支持网口设备连接入口，并可作为主通道参与控制与采样。
- 支持自动/手动控制模式切换、目标温度设置和手动 PWM 下发。
- 支持变温工况 PID、微调工况 PID、Smith 预估控制和共享死区参数整定。
- 支持实验数据按 CSV 文件记录，可配置保存目录和记录策略。
- 提供 HTTP、WebSocket 和 MCP 本机接口，便于脚本、第三方系统或大模型客户端接入。

## 技术栈

- Vue 3
- Vue Router
- Pinia
- Electron
- electron-vite
- serialport
- ws
- electron-builder

## 运行环境

建议使用以下环境：

- Windows 10 或 Windows 11
- Node.js 18 及以上
- npm 9 及以上

说明：

- Windows 下访问串口和部分文件能力可能需要管理员权限。
- 如果应用启动时申请管理员权限，请按实验环境需要允许。
- 打包后的 Windows 程序会携带管理员权限清单。

## 安装与启动

安装依赖：

```bash
npm install
```

开发启动：

```bash
npm run dev
```

预览已构建产物：

```bash
npm run start
```

## 构建打包

```bash
# 构建 Electron 与前端产物
npm run build

# 构建 Windows 安装包
npm run build:win

# 构建 macOS 安装包
npm run build:mac

# 构建 Linux 安装包
npm run build:linux
```

## 页面说明

### 监控主页

监控主页用于实验过程观察和连接控制，主要包含：

- 实时温度曲线。
- 目标温度设置。
- 串口和网口连接状态。
- 主通道选择。
- 录制开始、暂停、恢复和结束。
- CSV 会话状态。
- 系统事件和操作日志。

曲线支持历史数据查看，并可回到最新采样视图。

### 参数整定

参数整定页用于控制参数配置和下发，主要包含：

- 变温工况 PID 参数。
- 微调工况 PID 参数。
- Smith 预估控制参数。
- 共享死区和微调开关。
- 当前参数、已生效参数和历史参数对照。
- 超调、稳定时间、控制输出、扰动量等运行指标。

### 系统配置

系统配置页用于记录策略和显示策略配置，主要包含：

- 启用或关闭 CSV 记录。
- 设置是否自动开始记录。
- 设置全部断连时是否自动暂停。
- 配置 CSV 保存目录。
- 配置曲线横轴时间间隔和显示格数。

## 基本使用流程

1. 启动程序，并确认运行权限满足当前实验要求。
2. 在监控主页检查连接状态、主通道和记录策略。
3. 扫描并连接串口设备，或按实验需要连接网口设备。
4. 设置主通道，确认设备状态可以正常刷新。
5. 在监控主页设置目标温度或切换手动 PWM。
6. 如需记录实验数据，启用 CSV 后开始录制。
7. 如需整定控制效果，进入参数整定页修改 PID 或 Smith 参数并下发。
8. 实验结束后停止录制，使用生成的 CSV 文件进行分析。

## CSV 记录

CSV 记录以当前采样数据为基础，串口和网口通道分别维护记录状态。典型字段包括：

- `sampleIndex`：采样序号。
- `elapsedSeconds`：本次记录开始后的经过秒数。
- `channel`：数据通道，通常为 `serial` 或 `ethernet`。
- `temperature`：反馈温度。
- `setpoint`：当前设定值。
- `requestedSetpoint`：请求目标温度。
- `controlOutput`：控制输出。
- `disturbance`：扰动量。
- `overshootPercent`：超调百分比。
- `kp` / `ki` / `kd`：控制参数。

如果未配置有效保存目录，系统会保留内存中的采样数据，但不会落盘写入 CSV。

## 外部集成接口

应用启动后会在本机开放以下接口：

- HTTP API：`http://127.0.0.1:8056`
- MCP Endpoint：`http://127.0.0.1:8056/mcp`
- WebSocket：`ws://127.0.0.1:8057`

常用入口：

- 健康检查：`GET http://127.0.0.1:8056/health`
- 状态快照：`GET http://127.0.0.1:8056/api/snapshot`
- 主动刷新设备状态：`POST http://127.0.0.1:8056/api/refresh`
- 设置模式：`POST http://127.0.0.1:8056/api/mode`
- 设置目标温度：`POST http://127.0.0.1:8056/api/target-temperature`
- 设置手动 PWM：`POST http://127.0.0.1:8056/api/manual-pwm`
- 下发变温 PID：`POST http://127.0.0.1:8056/api/pid/tran`
- 下发微调 PID：`POST http://127.0.0.1:8056/api/pid/fine`
- 保存设备配置：`POST http://127.0.0.1:8056/api/save`

详细接口文档：

- [外部接口总览](docs/external-api.md)
- [快速接入指南](docs/integration-quickstart.md)
- [OpenAPI 规范](docs/openapi.yaml)
- [MCP 工具清单](docs/mcp-tools.json)

## 设备通信协议摘要

串口和 TCP 通道使用同一类文本命令协议，命令以 `!` 开头，以回车换行结束。

示例：

```text
!MODE=AUTO
!TEMP=58.0
!PWM=35
!GET=STATE
!GET=TRAN
!GET=FINE
!SAVE
```

典型响应：

```text
!ACK=OK
!ACK=ERR
!STATE=MODE:AUTO,PWM:35,GOAL:580,FB:575
```

协议支持可选 XOR 校验，格式为 `!BODY*XX`。实际使用中，上位机会通过封装后的串口、网口和外部 API 能力完成命令发送与状态同步。

## 目录结构

```text
src/
  main/                 Electron 主进程，负责串口、文件、外部接口等能力
  preload/              Electron 预加载桥接
  renderer/             Vue 渲染进程
    src/
      views/            页面：监控主页、参数整定、系统配置
      components/       通用组件
      router/           前端路由
      store/            Pinia 状态管理
      services/         仿真和业务服务

docs/
  external-api.md       外部接口总览
  integration-quickstart.md 快速接入指南
  openapi.yaml          HTTP/OpenAPI 规范
  mcp-tools.json        MCP 工具定义

resources/              应用图标等资源
build/                  构建资源
dist/                   前端构建输出
out/                    Electron 构建输出
```

## 开发工具

推荐使用：

- VS Code
- Volar
- ESLint
- Prettier
