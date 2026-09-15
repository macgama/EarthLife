import React, { useMemo, useEffect } from 'react';
import { useMap } from 'react-leaflet';
import { Polygon } from 'react-leaflet';
import L from 'leaflet';

export interface VisionPoint {
  lat: number;
  lon: number;
  radius: number; // in meters
}

interface FogOfWarProps {
  visionPoints: VisionPoint[];
  isActive: boolean;
}

export const FogOfWar: React.FC<FogOfWarProps> = ({ visionPoints, isActive }) => {
  const map = useMap();
  useEffect(() => {
    if (!map.getPane('fogPane')) {
      map.createPane('fogPane');
      map.getPane('fogPane').style.zIndex = '500'; // Above overlayPane (400) but below markerPane (600)
      map.getPane('fogPane').style.pointerEvents = 'none'; // So clicks pass through to the polygon
    }
  }, [map]);

  const positions = useMemo(() => {
    if (!isActive) return [];

    const outerRing = [
      [90, -360],
      [90, 360],
      [-90, 360],
      [-90, -360],
      [90, -360]
    ] as [number, number][];

    const holes = visionPoints.map(point => {
      const coords: [number, number][] = [];
      const points = 32;
      // Leaflet holes typically need to be wound in the opposite direction.
      // Clockwise vs counter-clockwise doesn't matter too much as long as it's opposite to the outer ring, 
      // but to be safe we generate it in a specific direction.
      for (let i = 0; i < points; i++) {
        const angle = ((points - i) * 360) / points;
        const radian = (angle * Math.PI) / 180;
        const rLat = point.radius / 6378137;
        const rLon = point.radius / (6378137 * Math.cos((Math.PI * point.lat) / 180));
        
        const lat = point.lat + (rLat * Math.cos(radian)) * (180 / Math.PI);
        const lon = point.lon + (rLon * Math.sin(radian)) * (180 / Math.PI);
        coords.push([lat, lon]);
      }
      return coords;
    });

    return [outerRing, ...holes];
  }, [visionPoints, isActive]);

  if (!isActive) return null;

  return (
    <Polygon
      positions={positions}
      pathOptions={{
        fillColor: '#000000', 
        fillOpacity: 0.6,     
        stroke: false,
        pane: 'fogPane',
        interactive: false
      }}
      eventHandlers={{
        click: (e) => {
          L.DomEvent.stopPropagation(e as any);
        }
      }}
    />
  );
};
