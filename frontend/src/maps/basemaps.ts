/**
 * The two basemaps under the risk layer.
 *
 * Both are key-less public tile services, which is deliberate: nothing on this
 * screen should stop working because an API key expired the morning of a demo.
 * They are also the only outbound requests the frontend makes on its own - if
 * the machine is offline the tiles simply do not paint and every marker,
 * number and panel still works over the dark background.
 *
 * Neither is a satellite image, and the labels say so. "Terrain" is
 * OpenTopoMap's *cartography* of SRTM elevation - contours and hillshading
 * drawn from a DEM - not a live optical pass. Calling it satellite imagery
 * would be exactly the kind of claim this project refuses to make.
 */

export interface Basemap {
  key: 'dark' | 'terrain';
  label: string;
  /** Shown under the layer switch, so nobody has to guess what they are seeing. */
  describes: string;
  url: string;
  attribution: string;
  maxZoom: number;
  /** Terrain tiles are light; the marker halos need a darker stroke over them. */
  light?: boolean;
}

export const BASEMAPS: Basemap[] = [
  {
    key: 'dark',
    label: 'Dark',
    describes: 'Esri dark gray canvas basemap. Best for reading risk colour.',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles &copy; Esri &mdash; Sources: Esri, DeLorme, HERE, USGS, NGA',
    maxZoom: 16,
  },
  {
    key: 'terrain',
    label: 'Terrain',
    describes: 'OpenTopoMap contours and hillshading from SRTM elevation. Not satellite imagery.',
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    attribution: 'Map data &copy; OpenStreetMap contributors, SRTM &middot; Style &copy; OpenTopoMap (CC-BY-SA)',
    maxZoom: 17,
    light: true,
  },
];

export function basemapFor(key: string | undefined): Basemap {
  return BASEMAPS.find((map) => map.key === key) ?? BASEMAPS[0];
}

/** Centre and zoom that frame the Indian landslide belt on first paint. */
export const INDIA_CENTER: [number, number] = [22.6, 79.2];
export const INDIA_ZOOM = 5;
