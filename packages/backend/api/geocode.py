from fastapi import APIRouter

from models.schemas import GeocodingResult
from services.geocoding import GeocodingService

router = APIRouter(prefix="/api/geocode", tags=["geocode"])

geocoding_service = GeocodingService()


@router.get("/search", response_model=list[GeocodingResult])
async def search_address(q: str, limit: int = 5):
    return await geocoding_service.search(q, limit)


@router.get("/reverse", response_model=GeocodingResult | None)
async def reverse_geocode(lat: float, lng: float):
    return await geocoding_service.reverse(lat, lng)
