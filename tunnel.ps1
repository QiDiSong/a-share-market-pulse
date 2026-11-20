# 为看板启动 Cloudflare 快速隧道，并把当前公网地址写进 公网地址.txt
# 由计划任务 MarketPulseTunnel 调用（也可手动右键“使用 PowerShell 运行”）
$ErrorActionPreference = 'SilentlyContinue'

$root = 'C:\Users\qidson01\Desktop\杂谈\A股量能看板'
$base = Join-Path $env:LOCALAPPDATA 'MarketPulse'
$exe = Join-Path $base 'cloudflared.exe'
$log = Join-Path $base 'tunnel.log'
$urlFile = Join-Path $root '公网地址.txt'

New-Item -ItemType Directory -Force -Path $base | Out-Null

if (-not (Test-Path -LiteralPath $exe)) {
    $src = Join-Path $env:TEMP 'cfd\cloudflared.exe'
    if (Test-Path -LiteralPath $src) {
        Copy-Item -LiteralPath $src -Destination $exe -Force
    } else {
        try {
            Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile $exe -TimeoutSec 180
        } catch {
            Set-Content -LiteralPath $urlFile -Value "cloudflared 下载失败：$($_.Exception.Message)" -Encoding utf8
            exit 1
        }
    }
}

# 已经在跑就不再开第二个隧道
$running = Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" -ErrorAction SilentlyContinue
if ($running) { exit 0 }

Remove-Item -LiteralPath $log -Force -ErrorAction SilentlyContinue

Start-Process -FilePath $exe `
    -ArgumentList 'tunnel', '--url', 'http://127.0.0.1:8765', '--no-autoupdate' `
    -WindowStyle Hidden -RedirectStandardError $log -RedirectStandardOutput (Join-Path $base 'tunnel.out.log')

$url = $null
for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-Path -LiteralPath $log) {
        $match = Select-String -LiteralPath $log -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -AllMatches | Select-Object -First 1
        if ($match) { $url = $match.Matches[0].Value; break }
    }
}

$keyFile = Join-Path $root 'access_key.txt'
$key = if (Test-Path -LiteralPath $keyFile) { (Get-Content -LiteralPath $keyFile -Raw).Trim() } else { '' }

if ($url) {
    $full = if ($key) { "$url/?k=$key" } else { "$url/" }
    $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Set-Content -LiteralPath $urlFile -Value @(
        "更新于 $stamp",
        "手机 / 外网访问地址：",
        $full,
        "",
        "注意：这是 Cloudflare 快速隧道，隧道或电脑重启后地址会变，重新打开本文件即可看到新地址。",
        "本机直连：http://127.0.0.1:8765"
    ) -Encoding utf8
} else {
    Set-Content -LiteralPath $urlFile -Value "隧道未能在 20 秒内建立，请查看 $log" -Encoding utf8
}
