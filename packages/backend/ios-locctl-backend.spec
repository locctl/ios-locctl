# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for ios-locctl backend (Python 3.12, macOS).
# Build: python3.12 -m PyInstaller packages/backend/ios-locctl-backend.spec --noconfirm

from PyInstaller.utils.hooks import collect_all, collect_submodules

# pymobiledevice3 has a LOT of dynamic imports — collect everything
pmd_datas, pmd_binaries, pmd_hiddenimports = collect_all('pymobiledevice3')

# developer_disk_image is an indirect dependency of pymobiledevice3 (imported
# at the top of services/mobile_image_mounter.py). PyInstaller doesn't pick
# it up via collect_all('pymobiledevice3'), so collect it explicitly.
ddi_datas, ddi_binaries, ddi_hidden = collect_all('developer_disk_image')

# uvicorn/fastapi also need their sub-modules collected
uvicorn_hidden = collect_submodules('uvicorn')
fastapi_hidden = collect_submodules('fastapi')

hidden = [
    *pmd_hiddenimports,
    *ddi_hidden,
    *uvicorn_hidden,
    *fastapi_hidden,
    'uvicorn.logging',
    'uvicorn.loops',
    'uvicorn.loops.auto',
    'uvicorn.protocols',
    'uvicorn.protocols.http',
    'uvicorn.protocols.http.auto',
    'uvicorn.protocols.websockets',
    'uvicorn.protocols.websockets.auto',
    'uvicorn.lifespan',
    'uvicorn.lifespan.on',
    'websockets',
    'websockets.legacy',
    'websockets.legacy.client',
    'websockets.legacy.server',
    'gpxpy',
    'httpx',
    'multipart',
]

a = Analysis(
    ['main.py'],
    pathex=['.'],
    binaries=[*pmd_binaries, *ddi_binaries],
    datas=[*pmd_datas, *ddi_datas],
    hiddenimports=hidden,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=['tkinter', 'matplotlib', 'PIL', 'numpy', 'scipy', 'pandas'],
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='ios-locctl-backend',
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
    name='ios-locctl-backend',
)
