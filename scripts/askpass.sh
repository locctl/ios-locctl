#!/bin/bash
# GUI password prompt for sudo using osascript
osascript -e 'Tell application "System Events" to display dialog "ios-locctl 需要管理員權限來建立 iOS 通道" default answer "" with hidden answer buttons {"Cancel", "OK"} default button "OK"' -e 'text returned of result' 2>/dev/null
