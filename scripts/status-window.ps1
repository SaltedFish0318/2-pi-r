$ErrorActionPreference = 'Continue'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$STATUS_FILE = Join-Path $env:USERPROFILE '.pi\agent\computer-use-status.txt'
$WIN_TITLE = 'pi-cu-status'

# 幂等：文件锁标记（Windows Hidden 模式下 MainWindowTitle 不可靠）
$LOCK_FILE = Join-Path $env:TEMP 'pi-cu-status.lock'
if (Test-Path $LOCK_FILE) {
  $pidInLock = [int]([System.IO.File]::ReadAllText($LOCK_FILE))
  $alive = Get-Process -Id $pidInLock -ErrorAction SilentlyContinue
  if ($alive) { exit 0 }
}
[System.IO.File]::WriteAllText($LOCK_FILE, [string]$PID)

$form = New-Object System.Windows.Forms.Form
$form.Text = $WIN_TITLE
$form.FormBorderStyle = 'None'
$form.StartPosition = 'Manual'
$form.TopMost = $true
$form.ShowInTaskbar = $false
$form.BackColor = [System.Drawing.Color]::FromArgb(20, 20, 20)
$form.Opacity = 0.95
$form.AutoSize = $true
$form.AutoSizeMode = 'GrowAndShrink'

$label = New-Object System.Windows.Forms.Label
$label.AutoSize = $true
$label.MaximumSize = New-Object System.Drawing.Size(560, 200)
$label.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 11)
$label.ForeColor = [System.Drawing.Color]::White
$label.Padding = New-Object System.Windows.Forms.Padding(14, 10, 14, 10)
$label.Text = 'pi computer-use'
$form.Controls.Add($label)

$wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea

$label.Add_MouseClick({ param($s, $e) if ($e.Button -eq 'Right') { $form.Close() } })
$form.Add_MouseClick({ param($s, $e) if ($e.Button -eq 'Right') { $form.Close() } })

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 250
$timer.Add_Tick({
  try {
    if (Test-Path $STATUS_FILE) {
      $text = [System.IO.File]::ReadAllText($STATUS_FILE, [System.Text.Encoding]::UTF8).Trim()
      if ($text) {
        if (-not $form.Visible) { $form.Visible = $true }
        $label.Text = $text
        $form.Left = $wa.Right - $form.Width - 24
        $form.Top = $wa.Bottom - $form.Height - 24
      } elseif ($form.Visible) {
        $form.Visible = $false
      }
    } elseif ($form.Visible) {
      $form.Visible = $false
    }
  } catch { }
})
$timer.Start()

$form.Left = $wa.Right - 300
$form.Top = $wa.Bottom - 80
$form.Visible = $false

[System.Windows.Forms.Application]::Run($form)
