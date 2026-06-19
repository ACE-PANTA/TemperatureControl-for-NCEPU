# 温控系统上位机

这是一个用于华北电力大学自动化系嵌入式综合实验的温控对象上位机程序，面向实验过程中的串口通信、温度曲线观察、PID 参数整定、仿真数据记录与 CSV 导出等场景，并预留网口通信扩展能力。

项目基于 Vue 3 + Electron 构建：

- Vue 负责界面渲染、页面交互与状态管理
- Electron 负责桌面应用封装，以及串口、文件读写等系统能力接入，并为后续网口能力预留系统接口

## 项目用途

本程序主要用于以下实验环节：

- 温控过程实时监测与曲线展示
- 串口链路下的设备连接测试
- 网口通信界面预留与后续协议扩展准备
- PID 参数调节、下发与效果观察
- 二阶振荡对象仿真与目标温度跟踪
- 温度采样数据按 CSV 文件记录，便于实验后分析

当前版本已经可以基本跑通真实串口通信、模拟输入与温控对象仿真流程，可用于实验联调、界面演示和上位机功能验证；网口功能目前仍处于待实现状态。

## 技术栈

- Vue 3
- Electron
- Pinia
- Vue Router
- serialport
- electron-builder

## 外部集成接口

系统启动后会在本机开放：

- HTTP + MCP: `http://127.0.0.1:8056`
- WebSocket: `ws://127.0.0.1:8057`

外部软件可以查询当前手/自动模式、当前工况、实时采样、TRAN/FINE PID 参数、死区和微调开关，也可以下发模式、PWM、目标温度和 PID 配置。

外部接口文档：

- 总览与调用说明：[docs/external-api.md](docs/external-api.md)
- 快速接入示例：[docs/integration-quickstart.md](docs/integration-quickstart.md)
- HTTP/OpenAPI 规范：[docs/openapi.yaml](docs/openapi.yaml)
- MCP 工具清单：[docs/mcp-tools.json](docs/mcp-tools.json)

## 运行环境

建议环境如下：

- Windows 10 或 Windows 11
- Node.js 18 及以上
- npm 9 及以上

说明：

- 应用在 Windows 下启动时会检查管理员权限
- 若当前未以管理员身份运行，程序会自动申请管理员权限
- 串口访问以及部分文件读写操作依赖管理员权限

## 安装依赖

```bash
npm install
```

## 开发启动

```bash
npm run dev
```

开发模式下会启动 Electron + Vue 联合调试环境。

如果系统弹出管理员权限申请，请允许，否则串口和部分日志功能可能无法正常使用。

## 构建打包

```bash
# 仅构建前后端产物
npm run build

# 构建 Windows 安装包
npm run build:win

# 构建 macOS 安装包
npm run build:mac

# 构建 Linux 安装包
npm run build:linux
```

Windows 打包结果会带管理员权限清单，安装后的程序启动时会自动请求管理员权限。

---

# Temperature Control System (STM32F407 + LAN8720A)

## 1. Hardware Connections

| Function | Pin | Description |
|---|---|---|
| DS18B20 | PB5 | Board temperature sensor |
| NTC Thermistor | PA0 (ADC1) | Heater temperature feedback |
| Heater Control | PE5 | Heater MOSFET |
| TIM9 CH2 | -- | PWM control (heater/fan) |
| Fan Control | PE4 | Circulation fan enable |
| Buzzer | PB6 | Alert sound |
| Key UP | PD1 | Increase |
| Key DOWN | PD2 | Decrease |
| Key STEP | PD3 | Step toggle (1/5/10) |
| Key AUTO | PD4 | Auto/Manual toggle |
| LED1 | PB3 | Status indicator |
| LED2 | PB4 | Status indicator |
| HMI Display | PD8/PD9 (USART3) | Touch screen |
| Debug UART | PA9/PA10 (USART1) | PC communication |
| Ethernet (RMII) | PA1,PA2,PA7,PC1,PC4,PC5,PB11,PB12,PB13 | LAN8720A |
| ETH_RESET | PB0 | LAN8720A reset |

### Network Setup (Direct PC Connection)

Default: **Static IP** (no DHCP).

**Step 1: Physical Connection**
- Connect STM32 RJ45 to PC Ethernet port with a cable.
- Check that the Link LED (green) near the LAN8720A is **solid ON**.

**Step 2: Configure PC Static IP**
1. Control Panel -> Network and Sharing Center -> Change Adapter Settings
2. Right-click Ethernet -> Properties -> Internet Protocol Version 4 (TCP/IPv4)
3. Select "Use the following IP address":
   - IP address: `192.168.1.10`
   - Subnet mask: `255.255.255.0`
   - Default gateway: leave blank
4. Click OK

**Step 3: Verify**
```bash
ping 192.168.1.100
```
Expected: `Reply from 192.168.1.100: bytes=32 time<1ms TTL=64`

**Step 4: TCP Connection**
```bash
nc 192.168.1.100 8000
# Or PuTTY: Connection type=Raw, Host=192.168.1.100, Port=8000
```

### Router Connection

- Router LAN must be `192.168.1.x` subnet
- `192.168.1.100` must not be occupied by another device
- Use `!NET=...` via UART to change IP, then `!SAVE`

---

## 2. Control Architecture

```
                    +-------------------+
Target Temp ------->|                   |------> PWM Output (0~100%)
                    |  Incremental PID  |          |
Feedback Temp ----->|  + Dead-time      |     +----+----+
                    |  Compensation     |     |         |
                    +-------------------+   Heater     Fan
                                             (>0)      (<0)
```

### How It Works

The thermal system has a large **pure time delay** (e.g., heat takes seconds to propagate from the heater to the NTC sensor). A traditional PID that adjusts every second will over-correct because the effect of the previous adjustment hasn't reached the sensor yet.

**Solution: Dead-time aware incremental PID**

1. **Error history** is updated every second (for accurate derivative calculation)
2. **PID output** is only updated every `pid_interval` seconds (default: 5s, >= system dead time)
3. Between adjustments, PWM is held constant, allowing the thermal system to respond
4. A **deadband** (default: +/-0.3°C) freezes output when the temperature is close enough
5. **Output rate limiting** (default: +/-8% per step) prevents aggressive PWM swings

### PID Formula

```
delta_u = Kp * [e(k) - e(k-1)]
        + Ki * e(k) * Ts
        + Kd * [e(k) - 2*e(k-1) + e(k-2)] / Ts

output = clamp(output_prev + delta_u, 0, 100)
```

Where:
- `e(k)` = target temperature - current temperature
- `Ts` = `pid_interval` (sampling period in seconds)
- `delta_u` is clamped to `+/- pid_max_delta`

---

## 3. Parameters

### A. System Control

| Parameter | Default | Range | Description |
|---|---|---|---|
| `manual_flag` | 1 (Manual) | 0/1 | 0=Auto, 1=Manual PWM |
| `target_temp` | 30.0 | -10~100 °C | Target temperature (auto mode) |
| `manual_pwm` | 0 | -100~100 | Manual PWM value |
| `step_value` | 1 | 1/5/10 | Key step amount |

### B. 变温工况 — 位置式 PID（主力）

位置式 PID 直接输出，靠积分分离防饱和。

| Parameter | Default | Range | Description |
|---|---|---|---|
| `tran_kp` | 3.0 | 0.1~50 | Proportional gain |
| `tran_ki` | 0.3 | 0~5 | Integral gain (eliminates steady-state error) |
| `tran_kd` | 1.0 | 0~10 | Derivative gain (damping, anti-overshoot) |
| `tran_interval` | 3 | 1~60 sec | Adjust interval |
| `tran_sep_threshold` | 10.0 | 1~50 °C | Integral separation threshold (|error|>threshold → Ki off) |

### C. 微调工况 — 增量式 PID

进入条件：系统稳定 + `fine_entry_min ≤ |error| ≤ fine_entry_max`

| Parameter | Default | Range | Description |
|---|---|---|---|
| `fine_kp` | 1.5 | 0.1~20 | Proportional gain (more conservative) |
| `fine_ki` | 0.1 | 0~3 | Integral gain |
| `fine_kd` | 2.0 | 0~10 | Derivative gain (stronger damping) |
| `fine_interval` | 8 | 1~60 sec | Adjust interval (slower, wait for system response) |
| `fine_range` | 5.0 | 1~20 % | Max output change per step (tighter) |
| `fine_entry_min` | 1.0 | 0.1~10 °C | Min \|error\| to enter fine mode |
| `fine_entry_max` | 3.0 | 0.5~20 °C | Max \|error\| to enter fine mode |

### D. 共享

| Parameter | Default | Range | Description |
|---|---|---|---|
| `pid_deadband` | 0.3 | 0.1~2.0 °C | Deadband width (shared by TRAN and FINE) |

### E. Network

| Parameter | Default | Description |
|---|---|---|
| `eth_ip` | 192.168.1.100 | Static IP (reboot required) |
| `eth_gateway` | 192.168.1.1 | Gateway (reboot required) |
| `eth_netmask` | 255.255.255.0 | Netmask (reboot required) |
| `tcp_port` | 8000 | TCP listen port (reboot required) |
| `eth_mac` | 02:00:00:00:00:01 | MAC address (reboot required) |

---

## 4. Command Protocol

### Frame Format

```
Request: !BODY\r\n              (without checksum)
         !BODY*XX\r\n           (with XOR checksum)

Reply:   !ACK=OK\r\n            (success)
         !ACK=OK*XX\r\n
         !ACK=ERR\r\n           (failure)
         !ACK=ERR*XX\r\n
         !response\r\n          (query result)
         !response*XX\r\n
```

- `!` frame header, `*XX` optional XOR checksum, `\r\n` frame tail
- Checksum: XOR of all bytes from `!` through last body character, formatted as 2-char uppercase hex
- Device accepts both formats (with and without checksum)
- **UART (USART1) and TCP (port 8000) use the same protocol**

### Commands

#### System Control

| Command | Example | Description |
|---|---|---|
| `MODE=AUTO` | `!MODE=AUTO\r\n` | Switch to auto mode |
| `MODE=MAN` | `!MODE=MAN\r\n` | Switch to manual mode |
| `TEMP=58.0` | `!TEMP=58.0\r\n` | Set target temperature (°C) |
| `PWM=50` | `!PWM=50\r\n` | Set manual PWM (-100~100, manual only) |
| `STEP=5` | `!STEP=5\r\n` | Set key step (1/5/10) |

#### PID Tuning

| Command | Example | Description |
|---|---|---|
| `TRAN=3.0,0.3,1.0` | `!TRAN=3.0,0.3,1.0\r\n` | Set Kp, Ki, Kd |
| `TRAN=3.0,0.3,1.0,3` | +interval | Also set interval |
| `TRAN=3.0,0.3,1.0,3,10` | +sep_threshold | Set all 5 params |
| `FINE=1.5,0.1,2.0` | `!FINE=1.5,0.1,2.0\r\n` | Set Kp, Ki, Kd |
| `FINE=1.5,0.1,2.0,8` | +interval | Also set interval |
| `FINE=1.5,0.1,2.0,8,5` | +range | Also set range |
| `FINE=1.5,0.1,2.0,8,5,1.0,3.0` | All 7 params | Set all (last 2 = entry_min, entry_max) |
| `FINEEN=1` | `!FINEEN=1\r\n` | Enable fine tuning condition; `0` keeps auto control in TRAN |
| `DEADBAND=0.3` | `!DEADBAND=0.3\r\n` | Set deadband width (°C) |

#### Network (reboot required after change)

| Command | Example |
|---|---|
| `NET=192.168.1.100,192.168.1.1,255.255.255.0,8000` | Set IP, GW, Netmask, Port |
| `MAC=02:00:00:00:00:01` | Set MAC address |

#### Query

| Command | Reply Example |
|---|---|
| `GET=STATE` | `STATE=MODE:AUTO,PWM:35,GOAL:580,FB:575` |
| `GET=TRAN` | `TRAN=KP:3.00,KI:0.300,KD:1.00,INT:3,ST:10.0` |
| `GET=FINE` | `FINE=KP:1.50,KI:0.100,KD:2.00,INT:8,RNG:5.0,EMN:1.0,EMX:3.0` |
| `GET=FINEEN` | `FINEEN=1` |
| `GET=DEADBAND` | `DEADBAND=0.30` |
| `GET=NET` | `NET=IP:192.168.1.100,GW:192.168.1.1,NM:255.255.255.0,PORT:8000` |
| `GET=ETH` | `ETH=LINK:1,PHY:0,ERR:0,PHYID:0007C0F1,RX:5,TX:5,ARP:2,ICMP:3,ANEG:1,TCP:0` |
| `GET=CONFIG` | All config parameters (multi-line) |

#### Persistence

| Command | Description |
|---|---|
| `SAVE` | Save current config to Flash immediately |
| `RESET` | Restore factory defaults (preserves MAC) |

> Parameters auto-save to Flash after 500ms delay on change. `!SAVE` forces immediate save.

---

## 5. Response Fields

### STATE (`GET=STATE`)

```
STATE=MODE:AUTO,PWM:35,GOAL:580,FB:575
```

| Field | Meaning | Description |
|---|---|---|
| MODE | Mode | AUTO=自动, MAN=手动 |
| PWM | Current PWM | -100~100, positive=heat, negative=fan |
| GOAL | Target ×10 | e.g. 580 = 58.0°C |
| FB | Feedback ×10 | e.g. 575 = 57.5°C |

### TRAN (`GET=TRAN`) — 变温工况

```
TRAN=KP:3.00,KI:0.300,KD:1.00,INT:3
```

| Field | Meaning | Description |
|---|---|---|
| KP | tran_kp | Proportional gain |
| KI | tran_ki | Integral gain |
| KD | tran_kd | Derivative gain |
| INT | tran_interval | Adjust interval (seconds) |

### FINE (`GET=FINE`) — 微调工况

```
FINE=KP:1.50,KI:0.100,KD:2.00,INT:8,RNG:5.0
```

| Field | Meaning | Description |
|---|---|---|
| KP | fine_kp | Proportional gain (conservative) |
| KI | fine_ki | Integral gain |
| KD | fine_kd | Derivative gain (strong damping) |
| INT | fine_interval | Adjust interval (seconds, slower) |
| RNG | fine_range | Max output change per step (%, tighter) |

### ETH Diagnostics (`GET=ETH`)

```
ETH=LINK:1,PHY:0,ERR:0,PHYID:0007C0F1,RX:5,TX:5,ARP:2,ICMP:3,ANEG:1,TCP:0
```

| Field | Meaning |
|---|---|
| LINK | 1=cable connected, 0=disconnected |
| PHY | PHY chip address (0 or 1, 255=not found) |
| ERR | Error code (0=OK) |
| PHYID | Chip ID (0007C0F1=LAN8720A, 00000000=not detected) |
| RX | Received packets |
| TX | Transmitted packets |
| ARP | ARP replies |
| ICMP | Ping replies |
| ANEG | 1=auto-negotiation complete, 0=not complete |
| TCP | 1=client connected, 0=no client |

### Ethernet Error Codes

| Code | Name | Meaning | Fix |
|---|---|---|---|
| 0 | `ETH_ERR_OK` | Link OK | -- |
| 1 | `ETH_ERR_NO_PHY` | PHY chip not found | Check PHY soldering/power/crystal |
| 2 | `ETH_ERR_NO_LINK` | No cable link | Check cable, peer power |
| 3 | `ETH_ERR_ANEG_TIMEOUT` | Auto-negotiation timeout | Check 50MHz RMII clock |
| 4 | `ETH_ERR_NOT_INITED` | ETH not initialized | Check eth.c included in build |

---

## 6. Quick Start

### First Power-On

```
1. Default: manual mode, target 30°C
2. Connect UART (115200 8N1) or TCP (nc 192.168.1.100 8000)
3. Send: MODE=AUTO
4. Send: TEMP=58.0
5. Observe: PID adjusts every pid_interval seconds (default 5s)
```

### Tuning Guide

```
1. TRAN (变温工况 — 位置式 PID):
   Temperature rises too slowly -> Increase tran_kp (3→5)
   Temperature overshoots       -> Increase tran_kd (1→3)
   Steady-state error persists  -> Increase tran_ki (0.3→0.6)
   Integral windup / PWM saturates -> Increase tran_interval (3→8) or decrease tran_ki

2. FINE (微调工况 — 增量式 PID):
   Small oscillations near target -> Decrease fine_kp (1.5→0.8), increase fine_kd (2→4)
   Convergence too slow           -> Increase fine_ki (0.1→0.3)
   PWM jumps too often            -> Increase fine_interval (8→15) or decrease fine_range (5→3)

3. DEADBAND (共享死区):
   Small oscillations near target -> Increase (0.3→0.5)
   Temperature stays off by ~0.5°C -> Decrease (0.3→0.1)

4. Save:
   SAVE
```

---

## 7. Build (STM32)

### Keil MDK

- Project: `USER/DS18B20.uvprojx`
- MCU: STM32F407VETx
- StdPeriph Library: V1.4.0
- Compiler: ARMCC V5.06

### File Structure

```
USER/
  main.c              Main program
  app_config.h/.c     Unified config system
  flash_params.h/.c   Flash persistence
  pid_control.h/.c    PID controller

HARDWARE/
  ETH/eth.h/.c        Ethernet driver
  LED/                LED driver
  DS18B20/            Temperature sensor
  KEY/                Keys
  BEEP/               Buzzer
  TIMER/              Timer
  ADC/                ADC
  HMI/                HMI display
  PWM/                PWM output
  DataScope_DP/       Data oscilloscope

SYSTEM/
  delay/              Delay
  sys/                System
  usart/              UART

FWLIB/                STM32F4 StdPeriph Library
```

---

## 8. Troubleshooting

| Symptom | Likely Cause | Fix |
|---|---|---|
| Temp stuck below target | TRAN Ki too weak | Increase tran_ki (0.3→0.6) |
| Large overshoot on heat-up | TRAN Kp too high / Kd too low | Decrease tran_kp (5→3), increase tran_kd (1→3) |
| PWM oscillates or saturates | TRAN Ki windup / interval too short | Increase tran_interval (3→8), decrease tran_ki |
| Oscillation near target | FINE Kp too high / Kd too low | Decrease fine_kp (1.5→0.8), increase fine_kd (2→4) |
| Slow convergence near target | FINE Ki too weak / interval too long | Increase fine_ki (0.1→0.3), decrease fine_interval (15→8) |
| Steady oscillation ±0.3°C | Deadband too small | Increase pid_deadband (0.3→0.5) |
| Network not connecting | IP mismatch / hardware | Use UART `GET=ETH` for diagnostics |
| Flash save fails | Sector erase error | Check FLASH_Sector_7 not occupied |

---

## 主要页面说明

### 1. 首页

首页主要用于实验过程监控与连接控制。

包含以下功能：

- 实时温度曲线显示
- 目标温度直接输入修改
- 串口连接状态查看
- 网口区域状态展示与界面预留
- 手动开始、暂停、恢复、结束录制
- 录制会话号与 CSV 存储状态显示
- 系统事件与操作日志显示

说明：

- 曲线横轴会随着采样推进持续更新
- 曲线支持拖动回看历史数据
- 可通过"回到最新"按钮恢复实时视图

### 2. PID 整定页

PID 整定页主要用于参数调节与对象参数设置。

包含以下功能：

- Kp、Ki、Kd 参数输入与滑块联动
- PID 参数下发
- 当前参数、已生效参数、历史参数对照
- 共享被控对象参数设置
- 参考公式显示
- 运行指标查看，如超调、稳定时间、控制输出、扰动量等

### 3. 系统配置页

系统配置页主要用于录制策略与路径配置。

包含以下功能：

- 启用或关闭 CSV 录制
- 设置是否自动开始录制
- 设置全部断连时是否自动暂停
- 配置 CSV 保存目录
- 配置横轴每格时间与显示格数

## 基本使用步骤

建议按照以下流程进行实验：

1. 启动程序，确认已获取管理员权限
2. 进入首页，检查右侧录制策略和连接区状态
3. 当前优先选择 COM 串口连接方式，网口功能暂不作为实验主流程
4. 扫描并连接串口设备，确认主通道已经建立
5. 在首页直接设置目标温度，观察曲线变化
6. 如需记录实验数据，在首页启动录制
7. 如需整定参数，进入 PID 整定页修改 Kp、Ki、Kd 并下发
8. 实验结束后停止录制，导出 CSV 文件进行分析

## CSV 记录说明

程序当前以串口链路的数据记录为主，网口记录能力待后续联调完成后接入。

记录规则如下：

- 采样周期为 1 秒
- 每 5 秒进行一次批量追加写入
- 每次新开始录制都会生成新的 CSV 会话文件
- 当前每次录制会生成串口侧 CSV 文件

CSV 文件中包含以下典型字段：

- sampleIndex
- elapsedSeconds
- channel
- temperature
- setpoint
- requestedSetpoint
- controlOutput
- disturbance
- overshootPercent
- kp / ki / kd

## 当前功能特点

- 支持真实串口通信链路
- 网口通信界面与配置入口已预留，协议对接待实现
- 支持主通道概念与连接提醒
- 支持二阶振荡对象仿真
- 支持增量式 PID 控制计算
- 支持目标温度实时修改
- 支持图表历史拖动查看
- 支持 CSV 记录与目录自定义
- 支持 PID 参数调节与历史对照

## 目录结构概览

```text
src/
  main/                 Electron 主进程
  preload/              Electron 预加载桥接
  renderer/             Vue 渲染进程
    src/
      views/            页面
      components/       公共组件
      store/            Pinia 状态管理
      services/         仿真与业务服务
```

## 推荐开发工具

- VS Code
- Volar
- ESLint
- Prettier

## 备注

本项目当前以实验教学与仿真联调为主要目标，现阶段已完成真实串口链路接入；后续仍可继续扩展真实网口协议对接、图表缩放、实验报告导出等能力。
