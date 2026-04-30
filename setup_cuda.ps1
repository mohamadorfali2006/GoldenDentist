# =============================================================================
# GoldenDentist - local CUDA training environment
#
# Creates a Python virtual environment in `.venv/`, installs PyTorch with the
# correct CUDA wheel for your driver, installs the rest of ai/requirements.txt,
# and runs ai/check_cuda.py to confirm everything is wired up.
#
# Usage (from repo root, in PowerShell):
#     .\setup_cuda.ps1
#
# If your script execution policy blocks it, run once:
#     Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
# =============================================================================

$ErrorActionPreference = "Stop"

$VENV   = ".venv"
$TORCH_CUDA_INDEX = "https://download.pytorch.org/whl/cu126"

Write-Host "========================================================" -ForegroundColor Cyan
Write-Host " GoldenDentist - local CUDA training setup" -ForegroundColor Cyan
Write-Host "========================================================" -ForegroundColor Cyan

# --- 1. Detect GPU --------------------------------------------------------
Write-Host "`n[1/5] Detecting NVIDIA GPU ..." -ForegroundColor Yellow
try {
    $smiOutput = & nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader 2>&1
    Write-Host "      $smiOutput"
} catch {
    Write-Host "      nvidia-smi not found. Install NVIDIA driver first:" -ForegroundColor Red
    Write-Host "      https://www.nvidia.com/Download/index.aspx" -ForegroundColor Red
    exit 1
}

# --- 2. Create venv -------------------------------------------------------
Write-Host "`n[2/5] Creating virtual environment in $VENV ..." -ForegroundColor Yellow
if (Test-Path $VENV) {
    Write-Host "      $VENV already exists - reusing."
} else {
    & py -3.12 -m venv $VENV
    if ($LASTEXITCODE -ne 0) {
        Write-Host "      Failed to create venv with py -3.12." -ForegroundColor Red
        exit 1
    }
}

. ".\$VENV\Scripts\Activate.ps1"

python -m pip install --upgrade pip --quiet

# --- 3. Install CUDA PyTorch ---------------------------------------------
Write-Host "`n[3/5] Installing CUDA-enabled PyTorch (~2.5 GB download)..." -ForegroundColor Yellow
python -m pip install --index-url $TORCH_CUDA_INDEX torch torchvision

# --- 4. Install the rest -------------------------------------------------
Write-Host "`n[4/5] Installing remaining Python deps ..." -ForegroundColor Yellow
python -m pip install -r ai/requirements.txt

# --- 5. Smoke-test CUDA --------------------------------------------------
Write-Host "`n[5/5] Verifying CUDA + PyTorch ..." -ForegroundColor Yellow
python ai/check_cuda.py
if ($LASTEXITCODE -ne 0) {
    Write-Host "`n      CUDA check FAILED. See output above." -ForegroundColor Red
    exit 1
}

Write-Host "`n========================================================" -ForegroundColor Green
Write-Host " All set. To activate the venv in a new shell:" -ForegroundColor Green
Write-Host "     .\.venv\Scripts\Activate.ps1" -ForegroundColor Green
Write-Host ""
Write-Host " VSCode picks the interpreter from .vscode\settings.json" -ForegroundColor Green
Write-Host " automatically. Use Run/Debug or Tasks (Ctrl+Shift+P ->" -ForegroundColor Green
Write-Host " 'Tasks: Run Task') to launch:" -ForegroundColor Green
Write-Host "   - Check CUDA" -ForegroundColor Green
Write-Host "   - Verify Aariz mapping" -ForegroundColor Green
Write-Host "   - Train (CUDA, full)" -ForegroundColor Green
Write-Host "   - Export ONNX" -ForegroundColor Green
Write-Host "========================================================" -ForegroundColor Green
