@echo off
echo Testing api.mikolab.bid 5 times...
echo.
for /L %%i in (1,1,5) do (
    echo === Test #%%i ===
    curl.exe -s -o nul -w "HTTP: %%{http_code} | DNS: %%{time_namelookup}s | Connect: %%{time_connect}s | Total: %%{time_total}s\n" https://api.mikolab.bid/
    echo.
    timeout /t 1 >nul
)
echo Done.