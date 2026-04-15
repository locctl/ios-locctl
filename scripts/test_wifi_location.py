from pymobiledevice3.remote.tunnel_service import create_core_device_tunnel_service_using_remotepairing
from pymobiledevice3.remote.remote_service_discovery import RemoteServiceDiscoveryService
import asyncio

async def test():
    print("1. Connecting to RemotePairing at 192.168.0.197:49152...")
    service = await create_core_device_tunnel_service_using_remotepairing(
        '00008027-000A116A0C07002E', '192.168.0.197', 49152
    )
    print("✓ RemotePairing connected")
    
    print("2. Starting TCP tunnel (TUN interface)...")
    async with service.start_tcp_tunnel() as tunnel:
        print(f"✓ Tunnel: {tunnel.address}:{tunnel.port}")
        
        print("3. Connecting to RSD...")
        rsd = RemoteServiceDiscoveryService((tunnel.address, tunnel.port))
        await rsd.connect()
        print("✓ RSD connected")
        
        print("4. Creating DVT provider...")
        from pymobiledevice3.services.dvt.instruments.dvt_provider import DvtProvider
        dvt = DvtProvider(rsd)
        async with dvt:
            print("✓ DVT provider opened")
            
            print("5. Creating LocationSimulation...")
            from pymobiledevice3.services.dvt.instruments.location_simulation import LocationSimulation
            loc = LocationSimulation(dvt)
            
            print("6. Connecting LocationSimulation service...")
            await loc.connect()
            print("✓ LocationSimulation connected")
            
            print("7. Setting location to 愛宕念佛寺 (35.031359, 135.661119)...")
            await loc.set(35.031359, 135.661119)
            print("✓ Location set!")
            print("\n>>> 檢查平板地圖，應該從山形跳到京都愛宕念佛寺 <<<\n")
            
            await asyncio.sleep(5)
            
            print("8. Clearing location...")
            await loc.clear()
            print("✓ Cleared (應該跳回台灣真實位置)")

asyncio.run(test())
