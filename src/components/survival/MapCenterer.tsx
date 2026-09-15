import React, { useEffect } from 'react';
import { useMap } from 'react-leaflet';

export const MapCenterer: React.FC<{ center: [number, number] | null; onCentered?: () => void }> = ({ center, onCentered }) => {
  const map = useMap();
  useEffect(() => {
    if (center) {
      map.setView(center, 16, { animate: true });
      if (onCentered) onCentered();
    }
  }, [center, map, onCentered]);
  return null;
};
