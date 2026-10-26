param([switch]$SelfTest)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$Root = $PSScriptRoot
$Cli = Join-Path $Root 'src\cli.js'
$Node = (Get-Command node.exe -ErrorAction Stop).Source
$Support = Join-Path $env:APPDATA 'CodexPP'
$CommandFile = Join-Path $Support 'command.json'
$LogFile = Join-Path $Support 'tray.log'
$PidFile = Join-Path $Support 'tray.pid'
$ExtDir = Join-Path $Support 'extensions'
$AppLog = Join-Path $Support 'codexpp.log'
$AppExe = Join-Path $env:LOCALAPPDATA 'CodexPP\app\app\ChatGPT.exe'

New-Item -ItemType Directory -Force -Path $Support | Out-Null

function Write-Log([string]$Message) {
  try {
    Add-Content -Path $LogFile -Value ("[{0}] {1}" -f (Get-Date).ToString('o'), $Message)
  } catch {}
}

if (-not $SelfTest -and (Test-Path $PidFile)) {
  $existing = 0
  try { $existing = [int](Get-Content $PidFile -Raw).Trim() } catch {}
  if ($existing -gt 0) {
    $running = Get-Process -Id $existing -ErrorAction SilentlyContinue
    if ($running) {
      Write-Log "already running pid=$existing"
      exit 0
    }
  }
}
if (-not $SelfTest) {
  Set-Content -Path $PidFile -Value $PID -Encoding ASCII
}

$icon = [System.Drawing.SystemIcons]::Application
if (Test-Path $AppExe) {
  try { $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($AppExe) } catch {}
}

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = $icon
$notify.Text = 'Codex++'
$notify.Visible = $true
$menu = New-Object System.Windows.Forms.ContextMenuStrip

function Show-Balloon([string]$Title, [string]$Text) {
  try { $notify.ShowBalloonTip(4000, $Title, $Text, [System.Windows.Forms.ToolTipIcon]::Info) } catch {}
}

function Run-Cli([string]$Arguments) {
  Show-Balloon 'Codex++' "Running: $Arguments"
  $out = Join-Path $env:TEMP ("codexpp-tray-" + [guid]::NewGuid().ToString('N') + ".out")
  $err = Join-Path $env:TEMP ("codexpp-tray-" + [guid]::NewGuid().ToString('N') + ".err")
  try {
    $argLine = "`"$Cli`" $Arguments"
    $process = Start-Process -FilePath $Node -ArgumentList $argLine -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
    $text = ''
    if (Test-Path $out) { $text = Get-Content $out -Raw -ErrorAction SilentlyContinue }
    if (Test-Path $err) { $text += (Get-Content $err -Raw -ErrorAction SilentlyContinue) }
    $lines = @($text -split "`r?`n" | Where-Object { $_ -and $_.Trim().Length -gt 0 })
    $last = ($lines | Select-Object -Last 1)
    if (-not $last) { $last = "exit $($process.ExitCode)" }
    Write-Log "$Arguments -> exit $($process.ExitCode): $last"
    Show-Balloon 'Codex++' $last
  } catch {
    Write-Log "$Arguments failed: $($_.Exception.Message)"
    Show-Balloon 'Codex++ error' $_.Exception.Message
  } finally {
    Remove-Item $out -Force -ErrorAction SilentlyContinue
    Remove-Item $err -Force -ErrorAction SilentlyContinue
  }
}

function Send-Command([hashtable]$Command) {
  $Command['ts'] = [DateTime]::UtcNow.Ticks
  $json = $Command | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText($CommandFile, $json, (New-Object System.Text.UTF8Encoding($false)))
  Write-Log "command $json"
}

function Add-Menu([string]$Text, [scriptblock]$Action) {
  $item = New-Object System.Windows.Forms.ToolStripMenuItem
  $item.Text = $Text
  $item.add_Click($Action)
  [void]$menu.Items.Add($item)
  return $item
}

$focus = $false
$focusItem = $null

[void](Add-Menu 'Status' { Run-Cli 'status' })
[void](Add-Menu 'Launch Codex++' { Run-Cli 'launch' })
[void](Add-Menu 'Appshot' { Run-Cli 'appshot --open' })
[void](Add-Menu 'Codex++ Settings' { Send-Command @{ panel = $true } })
$focusItem = Add-Menu 'Focus Mode: Off' {
  $script:focus = -not $script:focus
  if ($script:focus) {
    $script:focusItem.Text = 'Focus Mode: On'
  } else {
    $script:focusItem.Text = 'Focus Mode: Off'
  }
  Send-Command @{ focus = $script:focus }
}
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
[void](Add-Menu 'Extensions folder' { Start-Process explorer.exe $ExtDir })
[void](Add-Menu 'Open log' { Start-Process notepad.exe $AppLog })
[void](Add-Menu 'Check Codex update' { Run-Cli 'update' })
[void](Add-Menu 'Update Codex++' { Run-Cli 'self-update' })
[void](Add-Menu 'Restore Codex++' {
  $answer = [System.Windows.Forms.MessageBox]::Show(
    'Remove the patched copy and shortcuts? The Store app is untouched.',
    'Codex++',
    [System.Windows.Forms.MessageBoxButtons]::YesNo,
    [System.Windows.Forms.MessageBoxIcon]::Question
  )
  if ($answer -eq [System.Windows.Forms.DialogResult]::Yes) { Run-Cli 'restore' }
})
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
[void](Add-Menu 'Exit' {
  $notify.Visible = $false
  $notify.Dispose()
  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
  [System.Windows.Forms.Application]::Exit()
})

$notify.ContextMenuStrip = $menu
if ($SelfTest) {
  Write-Log "selftest start root=$Root cli=$Cli"
  Run-Cli 'status'
  Send-Command @{ panel = $true }
  Start-Sleep -Milliseconds 1200
  Send-Command @{ focus = $true }
  Start-Sleep -Milliseconds 1500
  Send-Command @{ focus = $false }
  $bytes = [System.IO.File]::ReadAllBytes($CommandFile)
  $bom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
  Write-Log "selftest command bytes=$($bytes.Length) bom=$bom"
  $notify.Visible = $false
  $notify.Dispose()
  exit 0
}
Write-Log "tray started pid=$PID"
Show-Balloon 'Codex++' 'Tray helper is running.'

[System.Windows.Forms.Application]::Run()
Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
