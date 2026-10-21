# ASCII-only launcher: starts toast-alert.ps1 through WMI so the process
# escapes the tool process tree (a plain spawn gets killed with the caller).
$ErrorActionPreference = 'Stop'
# Alarm asset dir = <DSH_HOME>\alarm; DSH_HOME defaults to %USERPROFILE%\.dsh
# (same rule as lib/alarm.js, so this launcher works on any machine).
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$alarmDir = Join-Path $dshHome 'alarm'
$script = Join-Path $alarmDir 'toast-alert.ps1'
$log = Join-Path $alarmDir 'alarm.log'
$title = '5oql6K2m6Ieq5rWL'
$body = 'ZHNoLWFsYXJtIOecn+acuuiHqua1i++8mumTg+WjsCArIOW8ueeql++8iHRvcG1vc3TvvIk='
$voiceText = '5oql6K2m6Ieq5rWL77ya6ZOD5aOw44CB5by556qX44CB6K+t6Z+z5Z2H5bey6Kem5Y+R'

$parts = @(
  'powershell.exe'
  '-NoProfile'
  '-ExecutionPolicy Bypass'
  '-WindowStyle Hidden'
  '-File "' + $script + '"'
  '-Title64 ' + $title
  '-Body64 ' + $body
  '-Kind selftest'
  '-Wav "Alarm03.wav"'
  '-Repeats 2'
  '-Voice 1'
  '-VoiceText64 ' + $voiceText
  '-VoiceName ""'
  '-VoiceRate 0'
  '-VoiceVolume 100'
  '-PopupStyle topmost'
  '-LogPath "' + $log + '"'
)
$line = $parts -join ' '
Write-Output ('CMD: ' + $line)
$result = ([wmiclass]'Win32_Process').Create($line)
Write-Output ('ReturnValue: ' + $result.ReturnValue)
Write-Output ('ProcessId: ' + $result.ProcessId)
