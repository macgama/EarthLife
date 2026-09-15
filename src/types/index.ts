export interface CityData {
  id: string;
  name: string;
  boundary?: string;
  createdAt: number;
  status?: 'loading' | 'ready' | 'error';
  lat?: number | null;
  lon?: number | null;
  population?: number | null;
  altitude?: number | null;
  areaKm2?: number | null;
  density?: number | null;
  country?: string | null;
  region?: string | null;
  county?: string | null;
  postalCode?: string | null;
  description?: string | null;
  imageUrl?: string | null;
  wikipediaUrl?: string | null;
  website?: string | null;
  wikidataId?: string | null;
  updatedAt?: number;
}

export interface MapFeatureData {
  id: string;
  type: 'structure' | 'poi' | 'area' | 'line';
  data: string;
}
