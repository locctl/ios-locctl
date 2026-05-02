# ios-locctl 使用說明

把 iPhone / iPad 的 GPS 定位「指定」到任何地方的 Mac 工具，主要拿來玩 Pikmin Bloom。

---

## 第一次安裝

### 1. 下載 dmg

到 [GitHub Releases](https://github.com/mars/ios-locctl/releases) 下載最新版的 dmg。
**選對應你 Mac 的版本**：

- Apple Silicon（M1 / M2 / M3 / M4）→ `arm64.dmg`
- Intel Mac → `x64.dmg`

不確定？點 Apple 選單 → 關於這台 Mac → 看 chip 那欄。

### 2. 安裝

1. 雙擊 dmg → 跳出視窗，看到 ios-locctl.app 跟 Applications 捷徑
2. 把 ios-locctl.app **拖到 Applications**

### 3. 第一次打開（重要！）

因為這個 app 沒有 Apple 簽章，macOS 第一次會擋。**正確流程**：

1. 到 Applications，**右鍵點 ios-locctl** → **打開**
2. 跳出警告 → 按「**仍要打開**」（不是「打開」按鈕，是文字旁邊的「打開」連結）
3. 之後雙擊就可以正常開了

**如果整個被當成損毀檔擋掉**（macOS Sequoia 偶爾會這樣）：
打開 Terminal，貼這行：

```bash
xattr -cr /Applications/ios-locctl.app
```

然後再雙擊就 OK。

---

## 第一次設定（Setup Wizard）

打開 app 後會自動跳出設定精靈，跟著走：

### 步驟 1 — 連接裝置

1. 用**資料線**接 iPhone 到 Mac（注意：充電線不行，要資料線。Apple 原廠線都是資料線）
2. iPhone 解鎖
3. iPhone 跳出「**信任這台電腦**」→ 按**信任** → 輸入裝置密碼

精靈會自動偵測到裝置。

### 步驟 2 — 準備 Developer Mode 選項

⚠️ **關鍵步驟**：iOS 16 以後，Developer Mode 的開關**預設不顯示**在設定裡。要先有電腦跟 iPhone「互動過」才會出現。

按精靈裡的「**幫我準備**」按鈕，app 會自動戳一下 iPhone 觸發這個機制。完成後到 iPhone 設定裡就會看到選項。

### 步驟 3 — 開啟 Developer Mode

精靈提供兩條路：

#### 推薦：手動開啟（不用清密碼）

1. 到 iPhone：**設定 → 隱私權與安全性**
2. 滑到最底，找 **「開發者模式」**（Developer Mode）
3. 打開開關
4. iPhone 會要求**重新開機** → 按「重新啟動」
5. 重開後解鎖 → 跳「Turn On Developer Mode」→ 按開啟 → 輸入裝置密碼
6. 回 app 點「**我已開啟**」

#### 備用：自動開啟（要先清密碼）

如果上面找不到開發者模式選項、或是覺得手動太麻煩，切到「自動開啟」這條：

1. **暫時清掉裝置密碼**：iPhone 設定 → Face ID 與密碼 → 關閉密碼
2. 回 app 按「**自動開啟 Developer Mode**」
3. iPhone 跳「Turn On Developer Mode」→ 按開啟 → 重新開機
4. 重開後**把密碼設回來**
5. 回 app 點「**我已重開**」

### 步驟 4 — 掛載 Developer Disk Image

按精靈裡的「**開始掛載**」。會從 GitHub 下載大約 20MB，第一次需要幾秒。

掛載失敗常見原因：

- Developer Mode 沒開好 → 回上一步檢查
- 連不到 github.com → 檢查網路、檢查 VPN
- iPhone 連線斷掉 → 拔 USB 重插一次

### 步驟 5 — 完成

設定完了！地圖會自動載入。

---

## 日常使用

### 基本操作

- **左鍵點地圖** → 設定一個目標點（不會瞬移，要手動觸發）
- **右鍵點地圖** → 跳出選單：瞬移、導航、加書籤
- **點書籤** → 設定書籤為目標點
- **狀態列「Restore」按鈕** → 清除模擬定位，回到真實 GPS

### 多種移動模式

頂端有 5 種模式 tab：

| 模式         | 用途                                                    |
| ------------ | ------------------------------------------------------- |
| **瞬移**     | 直接跳到目標點                                          |
| **導航**     | 從現在位置「走」到目標（可設速度，可選真實路線 / 直線） |
| **巡迴**     | 多個 waypoint 跑成迴圈，可在 waypoint 暫停              |
| **多點**     | 依序到多個 waypoint，每個停一下                         |
| **隨機漫步** | 在中心點半徑內隨機走                                    |
| **搖桿**     | 用 WASD / 方向鍵即時控制                                |

### 速度設定

每個模式都可以設速度：

- 預設：5 / 10 / 15 / 40 km/h（步行 / 跑步 / 腳踏車 / 開車）
- **自訂固定速度**：填一個數值
- **隨機範圍**：填 min-max（例如 40-80），每段路會在範圍內隨機

跑路途中改速度也可以 — 改完按 **Apply**，會從當下位置重算。

### 冷卻時間

狀態列有「冷卻」開關。打開後跳長距離會強制等冷卻時間（避免遊戲偵測）。

如果冷卻中還想跳，按狀態列冷卻時間旁邊的 X 取消。

---

## 玩 Pikmin Bloom 注意事項

詳細攻略在 [PIKMIN_GUIDE.md](PIKMIN_GUIDE.md)（給開發者的）。重點摘要：

- **跳長距離前確認皮克敏都回來了**（探險中的會跑去新位置，可能要等好幾天才回來）
- **種花途中不要跳點**（軌跡會異常）
- **打蘑菇要等冷卻**（日本打完跳歐洲建議等 2 小時）

---

## 常見問題

### 整個 app 起不來

1. 狀態列右下角 → 「**Log**」按鈕 → 看 `backend.log`
2. 常見原因：
   - **Port 8777 被佔用** → 檢查有沒有其他程式（其他 IDE、Docker）佔用
   - **第一次開沒按「仍要打開」** → 重來一次，右鍵打開

### 連不上 iPhone

- **拔 USB 重插** 解 80% 問題
- iPhone 解鎖
- 再次按「信任這台電腦」
- Re-pair 按鈕（裝置面板上）→ 重新建立配對

### Developer Mode 在設定裡找不到

- **再跑一次「準備 Developer Mode 選項」**：狀態列右下角 → 「重設設定」 → 重跑精靈到第 2 步
- 還不行？換「自動開啟（清密碼）」這條路

### 密碼變更後 Developer Mode 自動關掉

iOS 設計就是這樣 — 換密碼後 Developer Mode 會被停用。
回 iPhone 設定 → 隱私權與安全性 → Developer Mode 重開即可（不用重跑整個精靈）。

### Tunnel 起不來

- 重開 app
- 確認 Mac 密碼有輸入到位（會跳系統視窗）
- Re-pair 按鈕

### 想換 iPhone

點狀態列右下角「**重設設定**」→ 重跑精靈即可。

---

## 更新

- App 啟動時會自動檢查新版本，狀態列會顯示閃光的 **NEW** 標記
- 點 NEW 標記 → 開瀏覽器到 GitHub Release
- 下載新 dmg → 拖到 Applications → 跳「已存在」按取代
- 第一次開新版本要再「右鍵 → 打開 → 仍要打開」一次

---

## 反饋

問題回報：[GitHub Issues](https://github.com/mars/ios-locctl/issues)

附上資訊（log 在右下角「Log」按鈕）：

- macOS 版本 / Mac chip（M 系列 / Intel）
- iOS 版本
- 卡在哪一步、錯誤訊息
- backend.log 最後 50 行
