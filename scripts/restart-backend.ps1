# Reinicia el backend de desarrollo de esta copia (D-034, lo llama scripts/review-up.sh en Windows).
# El reloader de `fastapi dev` puede quedarse con el código anterior tras un fast-forward, y un `nohup`
# desde Git Bash deja colgada la tubería de quien llama; por eso se detiene y se lanza desacoplado.
$backend = Join-Path (Resolve-Path "$PSScriptRoot\..").Path 'backend'
$mine = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*$backend\.venv\Scripts\fastapi.exe*" }
foreach ($p in $mine) {
    # El worker de uvicorn es hijo del proceso de fastapi y hereda el socket: se detiene primero.
    Get-CimInstance Win32_Process -Filter "ParentProcessId=$($p.ProcessId)" |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}
Start-Process -FilePath 'uv' -ArgumentList 'run', 'fastapi', 'dev', 'src/valmont/main.py' `
    -WorkingDirectory $backend -WindowStyle Hidden `
    -RedirectStandardOutput "$env:TEMP\valmont-backend.log" -RedirectStandardError "$env:TEMP\valmont-backend.err.log"
