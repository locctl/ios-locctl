# ios-locctl — 專案筆記

macOS 上的 **iOS 虛擬定位控制器**。透過 USB / WiFi 連到 iPhone/iPad，把指定座標送進去當作真實 GPS。
主要使用情境：玩 **Pikmin Bloom**（飛人、收御神籤、打蘑菇、種花），也支援其他位置型遊戲與一般定位測試。

需要 macOS + Python 3.13+（WiFi RemotePairing 需要原生 TLS-PSK）+ Node 18+ + iOS 17+。

---

## 架構（pnpm monorepo）

```
ios-locctl/
├── packages/
│   ├── backend/      # Python FastAPI，唯一接觸 iOS 裝置的人
│   ├── frontend/     # React + Vite + Leaflet 地圖介面（也可包成 Electron）
│   └── cli/          # TypeScript CLI，純 HTTP client，呼叫 backend API
├── data/
│   ├── bookmarks.json   # 書籤（依分類存）
│   ├── bookmarks_old.json
│   └── settings.json    # last_position / coord_format / cooldown_enabled
└── scripts/          # dev.sh / setup-python.sh / start-backend.sh
```

**鐵律：CLI、Web、Electron 都不直接動裝置，全部過 backend HTTP API（`http://127.0.0.1:8777`）**。
這樣 state 一致，也只有一個地方需要 `sudo`（建立 iOS tunnel 用）。

### Backend（[packages/backend/](packages/backend/)）

- 入口：[main.py](packages/backend/main.py) — `AppState` 是中央狀態，含 `DeviceManager` / `SimulationEngine` / `CooldownTimer` / `BookmarkManager`。
- [config.py](packages/backend/config.py) — speed profiles、cooldown 表、API host/port、`DEFAULT_LOCATION`（台北市政府）。
- [core/](packages/backend/core/) — 各種「移動模式」實作（見下節）。`simulation_engine.py` 是 orchestrator。
- [services/](packages/backend/services/) — `location_service`（DVT/legacy）、`route_service`（OSRM）、`bookmarks`、`cooldown`、`gpx_service`、`coord_format`、`interpolator`、`reconnect`。
- [api/](packages/backend/api/) — FastAPI routers：`device` / `location` / `route` / `bookmarks` / `geocode` / `system` / `websocket`。
- [models/schemas.py](packages/backend/models/schemas.py) — Pydantic schemas 與 enums（`MovementMode`、`SimulationState`…）。
- 跑起來會用 `loop="asyncio"`（**不能用 uvloop**，跟 Python 3.13 TLS-PSK 不相容）。
- log 在 `~/.ios-locctl/logs/backend.log`（rotate）。
- 有 watchdog 每 2s poll usbmuxd，USB 拔掉會自動 disconnect 並 broadcast `device_disconnected`。

### Frontend（[packages/frontend/](packages/frontend/)）

- React 18 + Vite + Leaflet（沒用 react-leaflet，自己包）。
- 主要元件：[MapView.tsx](packages/frontend/src/components/MapView.tsx)、[ControlPanel.tsx](packages/frontend/src/components/ControlPanel.tsx)、[BookmarkList.tsx](packages/frontend/src/components/BookmarkList.tsx)、[JoystickPad.tsx](packages/frontend/src/components/JoystickPad.tsx)、[DeviceStatus.tsx](packages/frontend/src/components/DeviceStatus.tsx)。
- Hooks：[useSimulation.ts](packages/frontend/src/hooks/useSimulation.ts)（最大、所有模式入口）、[useDevice.ts](packages/frontend/src/hooks/useDevice.ts)、[useBookmarks.ts](packages/frontend/src/hooks/useBookmarks.ts)、[useJoystick.ts](packages/frontend/src/hooks/useJoystick.ts)、[useWebSocket.ts](packages/frontend/src/hooks/useWebSocket.ts)。
- API client：[services/api.ts](packages/frontend/src/services/api.ts)。
- 也可包成 Electron app（[electron/main.js](packages/frontend/electron/main.js) + `pnpm dist`）。

### CLI（[packages/cli/src/cli.ts](packages/cli/src/cli.ts)）

一個檔搞定，純 fetch 呼叫 backend。指令：`devices` / `status` / `jump` / `move` / `distance` / `stop` / `clear`。
`jump` / `distance` 還會顯示 haversine 距離與建議冷卻時間。

---

## 移動模式（API 層級對應 [packages/backend/api/location.py](packages/backend/api/location.py)）

所有模式都吃同一組速度參數：`mode`（walking/running/bicycling/driving）+ 可選 `speed_kmh` 或 `speed_min_kmh` / `speed_max_kmh`（範圍隨機）。
皆透過 `SimulationEngine` 派發到 [core/](packages/backend/core/) 的對應 handler。

| 模式 | API | Engine 方法 | 行為 |
|------|-----|------------|------|
| **Teleport（瞬移）** | `POST /api/location/teleport` | `teleport` | 直接設座標。受 cooldown 限制（429）。 |
| **Navigate（導航到單點）** | `POST /api/location/navigate` | `navigate` | OSRM 算路或直線（`direct_route=true`）。 |
| **Loop（循環巡迴）** | `POST /api/location/loop` | `start_loop` | 跑完 waypoint list 後再從頭跑。 |
| **MultiStop（多點導航）** | `POST /api/location/multistop` | `multi_stop` | 依序到每個 waypoint，可設停留時間 `stop_duration` 與 `loop`。 |
| **RandomWalk（隨機漫步）** | `POST /api/location/randomwalk` | `random_walk` | 在 `center` 附近 `radius_m` 內隨機走。 |
| **Joystick（搖桿）** | `POST /api/location/joystick/start` + WebSocket 推方向/強度 | `joystick_start` | WASD / 方向鍵 / 觸控搖桿即時控制。 |
| **Pause / Resume** | `POST /api/location/pause` `/resume` | — | 暫停目前動作，原地停。 |
| **Stop** | `POST /api/location/stop` | `stop` | 停止移動但**保留**模擬位置。 |
| **Restore** | `POST /api/location/restore` | `restore` | 清除模擬定位，回到真實 GPS。 |
| **Apply-speed（熱替換）** | `POST /api/location/apply-speed` | `apply_speed` | 跑路途中改速度，從當前位置重算。 |

LoopRequest / MultiStopRequest / RandomWalkRequest 都支援 `pause_enabled` + `pause_min/max`，模擬人在 waypoint 之間會停一下。

---

## 冷卻時間（cooldown）

Pikmin Bloom 沒有真的封人，但社群慣例是飛長距離後等冷卻避免異常被偵測。
- 表在 [config.py](packages/backend/config.py) `COOLDOWN_TABLE`（依距離 km 對應秒數）。
- 開關：`PUT /api/location/cooldown/settings`（`enabled`）。當前狀態：`GET /api/location/cooldown/status`。
- **Server 端強制**：cooldown 中發 teleport 直接回 429（API client 也擋不掉）。
- 走的時候在路上的時間可以抵冷卻，所以 `move` 慢一點到目的地剛好可操作。

---

## Bookmarks

**檔案：[data/bookmarks.json](data/bookmarks.json)**（這是現用的；`bookmarks_old.json` 是舊備份不要動）。

格式是 `{ 分類名: [{name, lat, lng, address, note}, …] }`，目前分類：

- `預設` — 全球景點（艾菲爾、雪梨歌劇院、唐老鴨雕像之類的觀光點）。
- `明信片花點` — 飛人收花用 / 觀光特色點當打卡背景。
- `明信片菇點` — 蘑菇刷點（地圖上有確認過的蘑菇坐標）。
- `隱藏明信片` — 特殊隱藏點。
- `裝飾純點` — 收裝飾皮克敏的點（POI 類型對的就行，不一定要特定地點）。

**主要在玩 Pikmin Bloom**，所以加新書籤前優先想分類；改檔時保持同樣的 JSON shape。

> 詳細的飛人玩法、御神籤、蘑菇攻略、星級門檻在 [PIKMIN_GUIDE.md](PIKMIN_GUIDE.md)。

---

## 常用指令

```bash
# 第一次設定（會建 .venv/，灌 backend Python deps，避開 PEP 668）
pnpm setup

# 開 dev（會 sudo 起 backend + 起 frontend dev server）
pnpm dev

# 只開 frontend / backend
pnpm dev:fe
pnpm dev:be

# 打包 Electron app
cd packages/frontend && pnpm dist

# CLI（要 backend 已啟動）
pnpm devices
pnpm status
pnpm jump 25.033,121.565       # 座標逗號中間【不能有空格】
pnpm move 25.040,121.570 60    # 60 km/h
pnpm distance 25.040,121.570
pnpm stop
pnpm clear
```

> **座標格式：`25.033,121.565` ✓ ｜ `25.033, 121.565` ✗**

`pnpm setup` 後 Python 都用 `.venv/bin/...`，不要直接呼叫系統 `pymobiledevice3`。

iOS 第一次接的 SOP：開 Developer Mode → 信任電腦 → 重開 → `pymobiledevice3 mounter auto-mount --tunnel ''` 掛 DeveloperDiskImage → `pnpm dev`。WiFi 模式首次要 USB 配對一次，之後拔線可掃 WiFi 連。

---

## 開發注意

- **不要 import `uvloop`**（Python 3.13 TLS-PSK 不相容，WiFi 配對會壞）。
- Backend 要 sudo 才能建 tunnel；如果要繞過 GUI 密碼可看 [scripts/askpass.sh](scripts/askpass.sh)。
- Settings 寫檔有節流（5 秒一次），改完關 process 不要急。
- 增 API endpoint 時：在 `api/` 加 router → `main.py` `include_router` → schema 放 `models/schemas.py` → frontend `services/api.ts` 加方法 → 對應 hook 包起來。
- 增移動模式時：在 `core/` 加 handler → `SimulationEngine` 加方法 → schema 加 Request → `api/location.py` 加 endpoint → frontend `useSimulation.ts` + `ControlPanel.tsx` 串 UI。
- Cooldown / cooldown bypass / device_lost 處理已經在 `api/location.py` 統一做掉，新模式呼叫 engine 時記得讓錯誤往上拋（特別是 `DeviceLostError`）。
