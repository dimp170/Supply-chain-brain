# Weather API Integration Skeleton

This is a free weather API skeleton for your supply chain application. All APIs used are **free** and **require no API keys**.

## Architecture

### Files Created:

1. **`types/weather.ts`** - Weather and risk zone data models
2. **`services/weatherService.ts`** - Open-Meteo API integration + risk detection
3. **`stores/weatherStore.ts`** - Zustand store for weather state
4. **`lib/riskCalculations.ts`** - Geospatial risk calculations
5. **`hooks/useWeatherUpdate.ts`** - React hooks for integration

## API Used

**Open-Meteo** (https://open-meteo.com)
- ✅ Free, no API key required
- ✅ No rate limiting
- ✅ Current weather + WMO codes
- ✅ Global coverage
- ✅ CORS friendly

## How to Integrate

### 1. Add to your main page.tsx:

```tsx
import { useWeatherUpdate, useVehicleRiskAssessment } from "@/hooks/useWeatherUpdate";

export default function HomePage() {
    // ... existing code ...
    
    // Add this:
    useWeatherUpdate(); // Fetches weather every 15 min
    const { vehicleRisks, vehicleRiskScores } = useVehicleRiskAssessment();
    
    // Now use vehicleRiskScores to display risk indicators
    return (
        <div>
            {/* Show risk badges on vehicles */}
            <VehicleMarker 
                vehicle={vehicle}
                riskScore={vehicleRiskScores.get(vehicle.id) || 0}
            />
        </div>
    );
}
```

### 2. Display risk on vehicle cards:

```tsx
// In VehicleSidebar.tsx or similar
<div className="p-2 bg-red-100 text-red-800" style={{ opacity: riskScore / 100 }}>
    Risk Level: {Math.round(riskScore)}/100
</div>
```

### 3. Render risk zones on map:

```tsx
// In WorldMap.tsx
riskZones.forEach((zone) => {
    // Draw circle at [zone.center[0], zone.center[1]] with radius zone.radius
    // Color by severity: LOW=green, MEDIUM=yellow, HIGH=orange, CRITICAL=red
});
```

## Next Steps

### Phase 1: Local Development (This Week)
- [ ] Integrate useWeatherUpdate hook into page.tsx
- [ ] Display risk scores in vehicle sidebar
- [ ] Render risk zones on map
- [ ] Test with mock data

### Phase 2: Enhanced APIs (Next Week)
- [ ] Add NOAA alerts (https://www.weather.gov/documentation/services-web-api)
- [ ] Add GFS hurricane forecasts for long-range tracking
- [ ] Add AQI data for air quality risks
- [ ] Implement mock geopolitical events

### Phase 3: BrevDev Deployment
- [ ] Deploy on BrevDev with NVIDIA NIM
- [ ] Add LLM-based recommendation engine
- [ ] Real-time alert streaming
- [ ] Historical analytics

## Data Flow

```
Open-Meteo API
    ↓
getWeatherForLocations()
    ↓
generateRiskZones() [detects heat, wind, rain, snow]
    ↓
weatherStore (Zustand)
    ↓
useVehicleRiskAssessment()
    ↓
vehicleRiskScores (0-100)
    ↓
Display on map/sidebar
```

## Testing Locally

```bash
# Run dev server
npm run dev

# In browser console:
fetch('https://api.open-meteo.com/v1/forecast?latitude=51.5&longitude=-0.1&current=temperature_2m,weather_code')
  .then(r => r.json())
  .then(d => console.log(d))

# Should see: { latitude, longitude, current: { temperature, weather_code, ... } }
```

## Free API Alternatives

If you need more data for future phases:

| Service | Coverage | Data | Free Tier |
|---------|----------|------|-----------|
| Open-Meteo | Global | Weather | Unlimited |
| NOAA | USA/Oceans | Alerts, Warnings | Unlimited |
| GFS | Global | 16-day forecast | Unlimited |
| AirNow | USA | Air quality | Limited |
| GDACS | Global | Disasters | Unlimited |

## Environment Variables

No API keys required! But if you add paid services later:

```env
# Add to .env.local if needed
NEXT_PUBLIC_WEATHER_API_KEY=
NEXT_PUBLIC_NOAA_API_KEY=
```

## Troubleshooting

**"Weather not updating?"**
- Check browser console for CORS errors
- Open-Meteo should work globally, no proxy needed

**"Risk zones not showing?"**
- Verify `generateRiskZones()` is being called
- Check that coordinates are in [lat, lon] format (not [lon, lat])

**"API Rate Limit?"**
- Open-Meteo has no rate limits
- If hitting 429, check for multiple parallel requests

---

Ready to integrate? Start with Step 1 above! 🚀
