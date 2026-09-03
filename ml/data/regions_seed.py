"""Reference dataset of monitored regions.

DEMO DATASET - IMPORTANT
------------------------
Coordinates are approximate district-headquarter / hill-station locations.
Terrain attributes (elevation, representative slope, soil, land cover) are
*plausible approximate values compiled for demonstration*, not extractions
from a DEM or a soil survey, and the historical counts are indicative rather
than an official inventory. Everything served from this file is tagged
data_source="DEMO reference dataset" and surfaces in the UI as DEMO.

To go live, replace `REGIONS` with a load from your authoritative sources -
Survey of India / Bhuvan district boundaries, Cartosat or SRTM DEM for
elevation and slope, NRSC land-use/land-cover, NBSS&LUP soil, and the GSI
National Landslide Susceptibility Mapping inventory for historical counts.
The rest of the platform does not change: only this loader does.

Row layout
    code, name, district, state, zone, lat, lon, elevation_m, slope_deg,
    soil_type, land_cover, historical_landslide_count, annual_rainfall_mm,
    monsoon_index
"""
from __future__ import annotations

ZONE_NAMES: dict[str, str] = {
    "HC": "HIMALAYA_CENTRAL",
    "HW": "HIMALAYA_WEST",
    "HE": "HIMALAYA_EAST",
    "NE": "NORTHEAST",
    "WG": "WESTERN_GHATS",
    "EG": "EASTERN_GHATS",
}

ZONE_LABELS: dict[str, str] = {
    "HIMALAYA_CENTRAL": "Central Himalaya",
    "HIMALAYA_WEST": "Western Himalaya",
    "HIMALAYA_EAST": "Eastern Himalaya",
    "NORTHEAST": "North-East Hills",
    "WESTERN_GHATS": "Western Ghats",
    "EASTERN_GHATS": "Eastern Ghats",
}

RAW_REGIONS: list[tuple] = [
    # --- Central Himalaya (Uttarakhand) -----------------------------------
    ("UK-RUD", "Rudraprayag", "Rudraprayag", "Uttarakhand", "HC", 30.284, 78.981, 1150, 39, "LOAM", "FOREST", 14, 1500, 1.20),
    ("UK-JOS", "Joshimath", "Chamoli", "Uttarakhand", "HC", 30.556, 79.564, 1875, 41, "GRAVEL", "SCRUB", 17, 1200, 1.10),
    ("UK-PIT", "Pithoragarh", "Pithoragarh", "Uttarakhand", "HC", 29.582, 80.218, 1615, 36, "LOAM", "FOREST", 11, 1350, 1.10),
    ("UK-TEH", "New Tehri", "Tehri Garhwal", "Uttarakhand", "HC", 30.377, 78.480, 1550, 37, "SILT", "AGRICULTURE", 9, 1250, 1.05),
    ("UK-UTT", "Uttarkashi", "Uttarkashi", "Uttarakhand", "HC", 30.729, 78.446, 1160, 42, "GRAVEL", "FOREST", 13, 1400, 1.15),
    ("UK-NAI", "Nainital", "Nainital", "Uttarakhand", "HC", 29.380, 79.463, 2000, 35, "CLAY", "FOREST", 12, 2100, 1.25),
    ("UK-BAG", "Bageshwar", "Bageshwar", "Uttarakhand", "HC", 29.837, 79.771, 1000, 34, "LOAM", "AGRICULTURE", 7, 1300, 1.05),
    ("UK-ALM", "Almora", "Almora", "Uttarakhand", "HC", 29.597, 79.659, 1640, 32, "LOAM", "FOREST", 6, 1100, 1.00),
    ("UK-CHM", "Champawat", "Champawat", "Uttarakhand", "HC", 29.336, 80.091, 1610, 33, "SILT", "FOREST", 5, 1450, 1.10),
    ("UK-MUS", "Mussoorie", "Dehradun", "Uttarakhand", "HC", 30.455, 78.072, 1880, 40, "CLAY", "BUILT_UP", 10, 2300, 1.30),
    # --- Western Himalaya (Himachal Pradesh, Jammu & Kashmir) -------------
    ("HP-SHI", "Shimla", "Shimla", "Himachal Pradesh", "HW", 31.104, 77.173, 2200, 34, "LOAM", "BUILT_UP", 11, 1550, 1.05),
    ("HP-KUL", "Kullu", "Kullu", "Himachal Pradesh", "HW", 31.958, 77.109, 1280, 40, "GRAVEL", "FOREST", 13, 1100, 1.00),
    ("HP-MAN", "Mandi", "Mandi", "Himachal Pradesh", "HW", 31.708, 76.932, 800, 36, "SILT", "AGRICULTURE", 15, 1350, 1.10),
    ("HP-KIN", "Reckong Peo", "Kinnaur", "Himachal Pradesh", "HW", 31.560, 78.270, 2960, 45, "ROCKY", "BARREN", 12, 700, 0.75),
    ("HP-CHA", "Chamba", "Chamba", "Himachal Pradesh", "HW", 32.556, 76.126, 1000, 38, "LOAM", "FOREST", 9, 1250, 1.00),
    ("HP-LAH", "Keylong", "Lahaul & Spiti", "Himachal Pradesh", "HW", 32.572, 77.024, 3080, 44, "ROCKY", "SNOW_ICE", 8, 600, 0.65),
    ("HP-SOL", "Solan", "Solan", "Himachal Pradesh", "HW", 30.905, 77.098, 1500, 30, "LOAM", "AGRICULTURE", 5, 1250, 1.00),
    ("HP-SIR", "Nahan", "Sirmaur", "Himachal Pradesh", "HW", 30.573, 77.293, 930, 31, "SILT", "FOREST", 6, 1400, 1.05),
    ("HP-KAN", "Dharamshala", "Kangra", "Himachal Pradesh", "HW", 32.219, 76.323, 1450, 33, "LOAM", "FOREST", 8, 2900, 1.35),
    ("JK-RAM", "Ramban", "Ramban", "Jammu & Kashmir", "HW", 33.244, 75.238, 1000, 43, "GRAVEL", "SCRUB", 19, 1050, 1.05),
    ("JK-DOD", "Doda", "Doda", "Jammu & Kashmir", "HW", 33.146, 75.547, 1100, 41, "ROCKY", "SCRUB", 12, 950, 0.95),
    ("JK-UDH", "Udhampur", "Udhampur", "Jammu & Kashmir", "HW", 32.916, 75.132, 750, 34, "SILT", "SCRUB", 9, 1300, 1.05),
    ("JK-REA", "Reasi", "Reasi", "Jammu & Kashmir", "HW", 33.081, 74.836, 550, 32, "CLAY", "SCRUB", 8, 1200, 1.00),
    ("JK-POO", "Poonch", "Poonch", "Jammu & Kashmir", "HW", 33.771, 74.093, 1000, 36, "LOAM", "FOREST", 7, 1400, 1.05),
    # --- Eastern Himalaya (Sikkim, Darjeeling hills, Arunachal) -----------
    ("SK-GAN", "Gangtok", "Gangtok", "Sikkim", "HE", 27.339, 88.606, 1650, 41, "SILT", "FOREST", 16, 3500, 1.55),
    ("SK-MAN", "Mangan", "Mangan", "Sikkim", "HE", 27.508, 88.532, 1250, 43, "GRAVEL", "FOREST", 13, 3300, 1.50),
    ("SK-NAM", "Namchi", "Namchi", "Sikkim", "HE", 27.166, 88.363, 1400, 38, "CLAY", "PLANTATION", 11, 2600, 1.40),
    ("SK-GYA", "Gyalshing", "Soreng", "Sikkim", "HE", 27.288, 88.256, 1300, 39, "SILT", "FOREST", 9, 2800, 1.45),
    ("WB-DAR", "Darjeeling", "Darjeeling", "West Bengal", "HE", 27.036, 88.263, 2050, 40, "CLAY", "PLANTATION", 21, 3100, 1.55),
    ("WB-KAL", "Kalimpong", "Kalimpong", "West Bengal", "HE", 27.060, 88.470, 1250, 38, "SILT", "PLANTATION", 17, 2200, 1.35),
    ("WB-KUR", "Kurseong", "Darjeeling", "West Bengal", "HE", 26.881, 88.277, 1450, 42, "CLAY", "PLANTATION", 14, 3600, 1.60),
    ("AR-ITA", "Itanagar", "Papum Pare", "Arunachal Pradesh", "HE", 27.084, 93.605, 600, 34, "LOAM", "FOREST", 12, 2800, 1.45),
    ("AR-TAW", "Tawang", "Tawang", "Arunachal Pradesh", "HE", 27.586, 91.866, 2670, 42, "ROCKY", "SCRUB", 10, 1700, 1.10),
    ("AR-BOM", "Bomdila", "West Kameng", "Arunachal Pradesh", "HE", 27.265, 92.400, 2400, 40, "GRAVEL", "FOREST", 9, 2100, 1.25),
    ("AR-ROI", "Roing", "Lower Dibang Valley", "Arunachal Pradesh", "HE", 28.140, 95.845, 400, 33, "ALLUVIAL", "FOREST", 8, 4100, 1.70),
    # --- North-East hills -------------------------------------------------
    ("AS-HAF", "Haflong", "Dima Hasao", "Assam", "NE", 25.164, 93.017, 680, 35, "SILT", "FOREST", 18, 2600, 1.40),
    ("AS-DIP", "Diphu", "Karbi Anglong", "Assam", "NE", 25.844, 93.430, 300, 28, "LOAM", "FOREST", 11, 2200, 1.30),
    ("AS-GUW", "Guwahati Hills", "Kamrup Metropolitan", "Assam", "NE", 26.150, 91.770, 150, 26, "LATERITE", "BUILT_UP", 14, 1800, 1.20),
    ("ML-SOH", "Sohra (Cherrapunji)", "East Khasi Hills", "Meghalaya", "NE", 25.270, 91.732, 1300, 37, "LATERITE", "GRASSLAND", 22, 11000, 1.95),
    ("ML-JOW", "Jowai", "West Jaintia Hills", "Meghalaya", "NE", 25.450, 92.200, 1380, 33, "LATERITE", "GRASSLAND", 12, 4200, 1.65),
    ("ML-NON", "Nongpoh", "Ri-Bhoi", "Meghalaya", "NE", 25.900, 91.880, 500, 30, "LATERITE", "FOREST", 9, 3200, 1.50),
    ("MZ-AIZ", "Aizawl", "Aizawl", "Mizoram", "NE", 23.727, 92.717, 1130, 38, "SILT", "FOREST", 20, 2500, 1.40),
    ("MZ-LUN", "Lunglei", "Lunglei", "Mizoram", "NE", 22.880, 92.734, 870, 36, "SILT", "FOREST", 12, 2700, 1.40),
    ("MN-NON", "Noney", "Noney", "Manipur", "NE", 24.830, 93.520, 700, 37, "CLAY", "FOREST", 15, 1900, 1.25),
    ("MN-CHU", "Churachandpur", "Churachandpur", "Manipur", "NE", 24.334, 93.684, 900, 34, "LOAM", "FOREST", 10, 2000, 1.25),
    ("NL-KOH", "Kohima", "Kohima", "Nagaland", "NE", 25.674, 94.110, 1440, 39, "SILT", "FOREST", 17, 2000, 1.30),
    ("TR-AMB", "Ambassa", "Dhalai", "Tripura", "NE", 23.930, 91.850, 100, 22, "CLAY", "PLANTATION", 6, 2200, 1.30),
    # --- Western Ghats ----------------------------------------------------
    ("KL-WAY", "Wayanad", "Wayanad", "Kerala", "WG", 11.685, 76.132, 900, 33, "LATERITE", "PLANTATION", 24, 3000, 1.60),
    ("KL-IDU", "Idukki", "Idukki", "Kerala", "WG", 9.849, 76.977, 1100, 36, "LATERITE", "PLANTATION", 20, 3400, 1.60),
    ("KL-KOZ", "Kozhikode Hills", "Kozhikode", "Kerala", "WG", 11.258, 75.780, 300, 26, "LATERITE", "PLANTATION", 13, 3200, 1.55),
    ("KL-NIL", "Nilambur", "Malappuram", "Kerala", "WG", 11.276, 76.229, 400, 30, "LATERITE", "FOREST", 15, 3300, 1.55),
    ("KL-PTA", "Pathanamthitta", "Pathanamthitta", "Kerala", "WG", 9.264, 76.787, 350, 27, "LATERITE", "PLANTATION", 11, 2900, 1.45),
    ("KL-KOT", "Kottayam Hills", "Kottayam", "Kerala", "WG", 9.591, 76.522, 250, 24, "LATERITE", "PLANTATION", 9, 3000, 1.45),
    ("KL-PAL", "Palakkad Hills", "Palakkad", "Kerala", "WG", 10.786, 76.655, 500, 28, "LATERITE", "FOREST", 8, 2400, 1.35),
    ("TN-NIL", "Ooty", "Nilgiris", "Tamil Nadu", "WG", 11.410, 76.695, 2200, 35, "CLAY", "PLANTATION", 19, 1900, 1.30),
    ("TN-VAL", "Valparai", "Coimbatore", "Tamil Nadu", "WG", 10.327, 76.951, 1100, 34, "LATERITE", "PLANTATION", 12, 3000, 1.50),
    ("TN-KOD", "Kodaikanal", "Dindigul", "Tamil Nadu", "WG", 10.238, 77.489, 2100, 32, "LOAM", "FOREST", 10, 1600, 1.20),
    ("KA-KOD", "Madikeri", "Kodagu", "Karnataka", "WG", 12.420, 75.740, 1150, 31, "LATERITE", "PLANTATION", 18, 3200, 1.55),
    ("KA-CHI", "Chikkamagaluru", "Chikkamagaluru", "Karnataka", "WG", 13.317, 75.774, 980, 30, "LATERITE", "PLANTATION", 14, 2600, 1.40),
    ("KA-SIR", "Sirsi", "Uttara Kannada", "Karnataka", "WG", 14.618, 74.844, 600, 28, "LATERITE", "FOREST", 11, 3500, 1.55),
    ("KA-SAK", "Sakleshpur", "Hassan", "Karnataka", "WG", 12.943, 75.783, 900, 29, "LATERITE", "PLANTATION", 12, 3400, 1.55),
    ("KA-AGU", "Agumbe", "Shivamogga", "Karnataka", "WG", 13.502, 75.093, 650, 32, "LATERITE", "FOREST", 13, 7500, 1.85),
    ("MH-MAH", "Mahad", "Raigad", "Maharashtra", "WG", 18.083, 73.417, 200, 29, "LATERITE", "AGRICULTURE", 16, 3500, 1.60),
    ("MH-AMB", "Ambegaon", "Pune", "Maharashtra", "WG", 19.170, 73.680, 700, 33, "LATERITE", "AGRICULTURE", 12, 3000, 1.50),
    ("MH-MBS", "Mahabaleshwar", "Satara", "Maharashtra", "WG", 17.924, 73.657, 1350, 34, "LATERITE", "FOREST", 14, 6000, 1.80),
    ("MH-IGA", "Igatpuri", "Nashik", "Maharashtra", "WG", 19.695, 73.556, 650, 31, "LATERITE", "GRASSLAND", 10, 3000, 1.50),
    ("MH-RAT", "Ratnagiri Ghat", "Ratnagiri", "Maharashtra", "WG", 17.000, 73.500, 250, 26, "LATERITE", "PLANTATION", 8, 3300, 1.55),
    ("MH-GAG", "Gaganbawda", "Kolhapur", "Maharashtra", "WG", 16.550, 73.833, 700, 32, "LATERITE", "FOREST", 9, 4500, 1.70),
    ("GA-SAN", "Sanguem", "South Goa", "Goa", "WG", 15.230, 74.150, 300, 25, "LATERITE", "FOREST", 5, 3200, 1.50),
    ("GJ-SAP", "Saputara", "Dang", "Gujarat", "WG", 20.575, 73.750, 950, 27, "LOAM", "FOREST", 6, 2400, 1.35),
    # --- Eastern Ghats ----------------------------------------------------
    ("AP-ARA", "Araku Valley", "Alluri Sitharama Raju", "Andhra Pradesh", "EG", 18.330, 82.870, 900, 26, "LATERITE", "PLANTATION", 7, 1400, 1.10),
    ("AP-PAD", "Paderu", "Alluri Sitharama Raju", "Andhra Pradesh", "EG", 18.083, 82.667, 1000, 27, "LOAM", "FOREST", 5, 1450, 1.10),
    ("OD-KOR", "Koraput", "Koraput", "Odisha", "EG", 18.813, 82.712, 870, 24, "LATERITE", "AGRICULTURE", 5, 1500, 1.10),
    ("OD-RAY", "Rayagada", "Rayagada", "Odisha", "EG", 19.170, 83.415, 400, 21, "LATERITE", "FOREST", 4, 1300, 1.05),
]

# Attributes that a real deployment would read off a raster are derived here
# deterministically from the region code, so the demo is identical on every
# machine and on every reload (no run-time randomness anywhere).
NDVI_BY_COVER = {
    "FOREST": 0.78, "PLANTATION": 0.62, "SCRUB": 0.45, "GRASSLAND": 0.42,
    "AGRICULTURE": 0.50, "BUILT_UP": 0.28, "BARREN": 0.12, "SNOW_ICE": 0.06,
}
DENSITY_BY_COVER = {
    "BUILT_UP": 950, "AGRICULTURE": 320, "PLANTATION": 240, "GRASSLAND": 140,
    "SCRUB": 110, "FOREST": 65, "BARREN": 25, "SNOW_ICE": 8,
}


def _unit(code: str, salt: str) -> float:
    """Stable pseudo-random value in [0, 1) derived from the region code."""
    import hashlib

    digest = hashlib.sha256(f"{code}|{salt}".encode("utf-8")).digest()
    return int.from_bytes(digest[:4], "big") / float(1 << 32)


def _span(code: str, salt: str, low: float, high: float) -> float:
    return low + _unit(code, salt) * (high - low)


def build_regions() -> list[dict]:
    """Expand the compact table into the full region records used everywhere."""
    out: list[dict] = []
    for row in RAW_REGIONS:
        (code, name, district, state, zkey, lat, lon, elev, slope,
         soil, cover, hist, annual_rain, monsoon) = row
        zone = ZONE_NAMES[zkey]
        area = round(_span(code, "area", 420.0, 3100.0), 1)
        density = DENSITY_BY_COVER[cover] * _span(code, "dens", 0.7, 1.45)
        out.append(
            {
                "code": code,
                "name": name,
                "district": district,
                "state": state,
                "zone": zone,
                "zone_label": ZONE_LABELS[zone],
                "latitude": lat,
                "longitude": lon,
                "elevation_m": float(elev),
                "slope_deg": float(slope),
                "aspect_deg": round(_span(code, "aspect", 0.0, 360.0), 1),
                "relief_m": round(_span(code, "relief", 180.0, 1400.0) * (0.5 + slope / 60.0), 1),
                "curvature": round(_span(code, "curv", -0.06, 0.06), 4),
                "soil_type": soil,
                "soil_depth_m": round(_span(code, "sdepth", 0.4, 4.5), 2),
                "land_cover": cover,
                "vegetation_index": round(
                    min(0.95, max(0.03, NDVI_BY_COVER[cover] + _span(code, "ndvi", -0.07, 0.07))), 3
                ),
                "distance_to_river_km": round(_span(code, "river", 0.2, 7.5) * (1.0 - min(0.45, hist / 60.0)), 2),
                "distance_to_road_km": round(_span(code, "road", 0.05, 4.0), 2),
                "lithology": None,
                "historical_landslide_count": int(hist),
                "annual_rainfall_mm": float(annual_rain),
                "monsoon_index": float(monsoon),
                "area_km2": area,
                "population_exposed": int(area * density / 10.0),
            }
        )
    return out


REGIONS: list[dict] = build_regions()
