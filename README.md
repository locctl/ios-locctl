# ios-locctl

**iOS Location Controller** — macOS 工具，透過 USB/WiFi 控制 iPhone/iPad 定位。

## 系統需求

- macOS
- Python 3.13+（WiFi RemotePairing 需要原生 TLS-PSK）
- Node.js 18+ & pnpm
- iOS 17+ 裝置

## 快速開始

```bash
# 1. 安裝依賴
pnpm run bootstrap

# 2. 開啟 Developer Mode（需暫時關閉密碼，完成後可設回）
.venv/bin/pymobiledevice3 amfi enable-developer-mode
# → 裝置跳「信任這台電腦」→ 按信任 → 重開機 → 確認開啟

# 3. 掛載 DeveloperDiskImage
.venv/bin/pymobiledevice3 mounter auto-mount --tunnel ''

# 4. 啟動服務
pnpm dev
```

`pnpm run bootstrap` 會在專案根目錄建立 `.venv/`，並把後端 Python 依賴安裝在這個虛擬環境中，避免 macOS/Homebrew Python 的 PEP 668 限制。
若要手動執行 Python CLI，請優先使用 `.venv/bin/...`，不要直接呼叫系統上的 `pymobiledevice3`。
目前 backend 啟動時不會自動連線裝置；請在介面中手動選擇並連線。

開啟瀏覽器訪問 `http://localhost:5173`

---

## 連線方式

### USB（預設）

插上 USB 資料線，啟動服務即自動連接。

### WiFi（首次需 USB 配對）

1. **首次配對：** 插 USB → 啟動服務 → 配對完成（生成 `~/.pymobiledevice3/remote_*.plist`）
2. **之後使用：** 拔 USB → 點「Scan」→ 選擇 WiFi 裝置 → 連接
3. **換網路：** 不用重新配對，重新掃描即可
4. **掃不到：** 點「Manual」手動輸入裝置 WiFi IP
5. **配對損壞：** 點「Repair」→ 插 USB 重新配對

> 配對記錄永久有效，除非手動清除或裝置重置。

---

## 使用方式

### Web 介面（推薦）

- 地圖點擊瞬移
- 右鍵選單：瞬移、導航、加書籤
- 路線規劃與巡迴、多點導航
- 隨機漫步
- 搖桿即時控制（WASD / 方向鍵）
- 冷卻計時器
- GPX 匯入/匯出

### CLI 指令

CLI 透過後端 API 操作，需先啟動 `pnpm dev`。

```bash
pnpm devices                   # 列出裝置（USB + WiFi）
pnpm status                    # 查看當前位置與狀態
pnpm jump 25.033,121.565       # 瞬移到座標
pnpm move 25.040,121.570 60    # 導航移動（速度 km/h）
pnpm distance 25.040,121.570   # 計算距離與冷卻時間
pnpm stop                      # 停止模擬
pnpm clear                     # 清除模擬定位
```

---

## 專案架構

```
ios-locctl/
├── packages/
│   ├── backend/      # Python FastAPI 後端（統一處理 USB/WiFi 連線）
│   ├── frontend/     # React + Vite 前端
│   └── cli/          # TypeScript CLI（HTTP 客戶端，調用後端 API）
├── data/
│   ├── bookmarks.json  # 預設座標書籤
│   └── settings.json   # 狀態與設定（CLI/Web 共用）
├── package.json
└── pnpm-workspace.yaml
```

**所有操作統一透過後端 API：** CLI 和 Web 介面不直接操作裝置，確保狀態一致。

---

## 注意事項

- USB 需要**資料線**（Finder 看不到裝置 = 充電線）
- WiFi 模式下拔線後定位持續有效（直到服務停止）
- **座標格式：逗號中間不能有空格** — `25.033,121.565` ✓ | `25.033, 121.565` ✗
- `data/bookmarks.json` 有預設座標可參考

---

## 遊戲使用指南

使用本工具進行 Pikmin Bloom 等位置類遊戲時，請參考：

**📖 [Pikmin Bloom 飛人指南](PIKMIN_GUIDE.md)**

---

## 致謝

本專案參考了 [locwarp](https://github.com/keezxc1223/locwarp) 的架構與實作。
