# ios-locctl

**iOS Location Controller** — macOS 工具，透過 USB/WiFi 控制 iPhone/iPad 定位。

## 系統需求

- macOS
- Python 3.12+ (Web 介面) / Python 3.13+ (WiFi Tunnel)
- Node.js 18+ & pnpm
- iOS 17+ 裝置

## 快速開始

```bash
# 1. 安裝依賴
pnpm setup

# 2. 開啟 Developer Mode（需暫時關閉密碼，完成後可設回）
pymobiledevice3 amfi enable-developer-mode
# → 平板/手機跳「信任這台電腦」→ 按信任 → 重開機 → 確認開啟

# 3. 掛載 DeveloperDiskImage
pymobiledevice3 mounter auto-mount --tunnel ''

# 4. 啟動（會彈密碼框要求 sudo 權限）
pnpm dev
```

開啟瀏覽器訪問 `http://localhost:5173`

---

## 使用方式

### Web 介面（推薦）

**功能：**
- 地圖點擊瞬移
- 右鍵選單：瞬移、導航、加書籤
- 路線規劃與巡迴
- 多點導航
- 隨機漫步
- 搖桿即時控制（WASD / 方向鍵）
- 冷卻計時器
- GPX 匯入/匯出
- WiFi 無線控制（設定後可拔 USB）

### CLI 指令

```bash
pnpm devices                   # 列出裝置
pnpm status                    # 查看當前模擬位置
pnpm jump 25.033,121.565       # 跳到指定座標（支援簡寫）
pnpm move 25.040,121.570 60    # 從當前位置移動（速度 km/h）
pnpm distance 25.040,121.570   # 計算距離與冷卻時間
pnpm clear                     # 清除模擬定位
```

**狀態同步：** CLI 和 Web 介面共用 `data/settings.json`，狀態完全同步。

---

## 專案結構

```
ios-locctl/
├── packages/
│   ├── backend/      # Python FastAPI 後端
│   ├── frontend/     # React + Vite 前端
│   └── cli/          # TypeScript CLI
├── data/
│   ├── bookmarks.json  # 預設座標書籤
│   └── settings.json   # 狀態與設定
├── package.json
└── pnpm-workspace.yaml
```

---

## 注意事項

- USB **資料線**要一直插著（WiFi Tunnel 設定後可拔線）
- Finder 看不到裝置 = 充電線（需要資料線）
- 進程結束或拔線，定位會恢復真實位置
- **座標格式：逗號中間不能有空格** — `25.033,121.565` ✓ | `25.033, 121.565` ✗

---

## 遊戲使用指南

使用本工具進行 Pikmin Bloom 等位置類遊戲時，請參考：

**📖 [Pikmin Bloom 飛人指南](PIKMIN_GUIDE.md)**

內容包含：
- 冷卻時間與安全做法
- 裝飾皮克敏收集指南
- 蘑菇戰鬥效率攻略
- 風險評估與社群現況

---

## 致謝

本專案參考了 [locwarp](https://github.com/keezxc1223/locwarp) 的架構與實作。
