@echo off
setlocal
set DATA=C:\Users\meinhard\AppData\Roaming\Freedom

echo === Killing app + node processes ===
taskkill /F /IM Freedom.exe /T
taskkill /F /IM bee.exe /T
taskkill /F /IM ipfs.exe /T

echo === Waiting for handles to release ===
ping -n 4 127.0.0.1 >nul

echo === Deleting identity + node data ===
rmdir /S /Q "%DATA%\identity"
rmdir /S /Q "%DATA%\bee-data"
rmdir /S /Q "%DATA%\ipfs-data"

echo === Remaining contents of Freedom data dir ===
dir "%DATA%"
endlocal
