# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for the privileged tunnel sidecar (tunnel_sidecar.py).
# Build: python3.13 -m PyInstaller packages/backend/wifi-tunnel.spec --noconfirm
# Output: packages/backend/dist/wifi-tunnel/wifi-tunnel (onedir mode)
#
# Why a separate binary:
# - In dev, device_manager.py spawns `sudo -A python tunnel_sidecar.py ...`.
# - Once the backend is frozen, sys.executable is the backend binary itself
#   and can't run a .py file. The sidecar therefore needs its own frozen
#   binary that the bundled backend invokes via `sudo -A wifi-tunnel ...`.

from PyInstaller.utils.hooks import collect_all, copy_metadata

# Same pymobiledevice3 + developer_disk_image collect as the main backend —
# the sidecar imports lockdown / remote_service_discovery / tunnel_service /
# bonjour / common / pair_records, which collect_all('pymobiledevice3')
# covers. developer_disk_image is pulled in by mobile_image_mounter that
# may transitively load.
pmd_datas, pmd_binaries, pmd_hiddenimports = collect_all('pymobiledevice3')
ddi_datas, ddi_binaries, ddi_hidden = collect_all('developer_disk_image')

# Mirror the metadata-bundle workaround from ios-locctl-backend.spec.
metadata_datas = (
    copy_metadata('apple_compress') + copy_metadata('pyimg4')
)

hidden = [
    *pmd_hiddenimports,
    *ddi_hidden,
    'pymobiledevice3.lockdown',
    'pymobiledevice3.remote.remote_service_discovery',
    'pymobiledevice3.remote.tunnel_service',
    'pymobiledevice3.common',
    'pymobiledevice3.pair_records',
]

a = Analysis(
    ['tunnel_sidecar.py'],
    pathex=['.'],
    binaries=[*pmd_binaries, *ddi_binaries],
    datas=[*pmd_datas, *ddi_datas, *metadata_datas],
    hiddenimports=hidden,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=['tkinter', 'matplotlib', 'PIL', 'numpy', 'scipy', 'pandas', 'fastapi', 'uvicorn'],
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='wifi-tunnel',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name='wifi-tunnel',
)
